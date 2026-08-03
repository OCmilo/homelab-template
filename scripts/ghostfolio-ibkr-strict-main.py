import logging
import os
import time

import SyncIBKR as sync_ibkr_module
from SyncIBKR import SyncIBKR

template = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(level=logging.INFO, format=template)
logger = logging.getLogger(__name__)

SYNCIBKR = "SYNCIBKR"
DEFAULT_IBKR_FLEX_MAX_TRIES = 60
DEFAULT_IBKR_FLEX_RETRY_DELAY_SECONDS = 30
RETRYABLE_SEND_REQUEST_CODES = {"1003"}


def configure_ibflex_download_retries():
    max_tries_raw = os.environ.get("IBKR_FLEX_MAX_TRIES", str(DEFAULT_IBKR_FLEX_MAX_TRIES))
    retry_delay_raw = os.environ.get(
        "IBKR_FLEX_RETRY_DELAY_SECONDS",
        str(DEFAULT_IBKR_FLEX_RETRY_DELAY_SECONDS),
    )
    try:
        max_tries = int(max_tries_raw)
    except ValueError:
        raise RuntimeError("IBKR_FLEX_MAX_TRIES must be an integer, got {}".format(max_tries_raw))
    try:
        retry_delay = int(retry_delay_raw)
    except ValueError:
        raise RuntimeError(
            "IBKR_FLEX_RETRY_DELAY_SECONDS must be an integer, got {}".format(retry_delay_raw)
        )

    if max_tries < 1:
        raise RuntimeError("IBKR_FLEX_MAX_TRIES must be >= 1, got {}".format(max_tries))
    if retry_delay < 1:
        raise RuntimeError(
            "IBKR_FLEX_RETRY_DELAY_SECONDS must be >= 1, got {}".format(retry_delay)
        )

    original_download = sync_ibkr_module.client.download
    original_sleep = sync_ibkr_module.client.time.sleep

    def download_with_retries(token, query_id, *args, **kwargs):
        kwargs.setdefault("max_tries", max_tries)
        for attempt in range(1, max_tries + 1):
            # ibflex's download() polls with the delay returned by IBKR (usually
            # one second).  Pace that internal loop so MAX_TRIES and the
            # configured delay really describe the intended retry window.
            def wait_for_statement(delay):
                original_sleep(max(delay, retry_delay))

            sync_ibkr_module.client.time.sleep = wait_for_statement
            try:
                return original_download(token, query_id, *args, **kwargs)
            except sync_ibkr_module.client.ResponseCodeError as error:
                code = str(getattr(error, "code", ""))
                if code not in RETRYABLE_SEND_REQUEST_CODES or attempt == max_tries:
                    raise

                logger.warning(
                    "IBKR Flex request returned retryable code %s on attempt %s/%s; "
                    "retrying in %s seconds",
                    code,
                    attempt,
                    max_tries,
                    retry_delay,
                )
                time.sleep(retry_delay)
            finally:
                sync_ibkr_module.client.time.sleep = original_sleep

    sync_ibkr_module.client.download = download_with_retries
    logger.info(
        "Configured IBKR Flex retries: max tries=%s, request delay=%ss",
        max_tries,
        retry_delay,
    )


class StrictSyncIBKR(SyncIBKR):
    def get_symbol_for_trade(self, trade, data_source):
        symbol = trade.symbol
        isin = getattr(trade, "isin", None)

        if data_source == "YAHOO" and isin is not None and len(isin) > 0:
            symbol = isin

        if symbol in self.symbol_mapping:
            logger.info("Transformed symbol %s into %s", symbol, self.symbol_mapping[symbol])
            return self.symbol_mapping[symbol]

        if data_source == "YAHOO" and isin is not None and len(isin) > 0:
            raise RuntimeError(
                "Unmapped IBKR ISIN {}. Add it to /usr/app/src/mapping.yaml before syncing.".format(symbol)
            )

        logger.info("Symbol %s not found in mapping; using it as-is.", symbol)
        return symbol


def split_env(name, default=""):
    return os.environ.get(name, default).split(",")


if __name__ == "__main__":
    configure_ibflex_download_retries()

    ghost_keys = split_env("GHOST_KEY")
    ghost_tokens = split_env("GHOST_TOKEN")
    ibkr_tokens = split_env("IBKR_TOKEN")
    ibkr_queries = split_env("IBKR_QUERY")
    ghost_hosts = split_env("GHOST_HOST", "https://ghostfol.io")
    ibkr_account_ids = split_env("IBKR_ACCOUNT_ID")
    ghost_account_names = split_env("GHOST_ACCOUNT_NAME", "Interactive Brokers")
    ghost_currencies = split_env("GHOST_CURRENCY", "USD")
    operations = split_env("OPERATION", SYNCIBKR)
    ghost_ibkr_platforms = split_env("GHOST_IBKR_PLATFORM")

    for i in range(len(operations)):
        if operations[i] != SYNCIBKR:
            raise RuntimeError("Unsupported operation in strict IBKR runner: {}".format(operations[i]))

        ghost = StrictSyncIBKR(
            ghost_hosts[i] if len(ghost_hosts) > i else ghost_hosts[-1],
            ibkr_tokens[i] if len(ibkr_tokens) > i else ibkr_tokens[-1],
            ibkr_queries[i] if len(ibkr_queries) > i else ibkr_queries[-1],
            ghost_keys[i] if len(ghost_keys) > i else ghost_keys[-1],
            ghost_tokens[i] if len(ghost_tokens) > i else ghost_tokens[-1],
            ibkr_account_ids[i] if len(ibkr_account_ids) > i else ibkr_account_ids[-1],
            ghost_account_names[i] if len(ghost_account_names) > i else ghost_account_names[-1],
            ghost_currencies[i] if len(ghost_currencies) > i else ghost_currencies[-1],
            ghost_ibkr_platforms[i] if len(ghost_ibkr_platforms) > i else ghost_ibkr_platforms[-1],
        )
        logger.info(
            "Starting strict sync for account %s: %s",
            i,
            ibkr_account_ids[i] if len(ibkr_account_ids) > i else "Unknown",
        )
        ghost.sync_ibkr()
        logger.info("End sync")
