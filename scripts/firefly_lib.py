"""Shared plumbing for the Firefly maintenance jobs.

Env, Healthchecks pings, Telegram and a thin Firefly API client, so the
normalize / autocategorize / alert jobs stay small and agree on paths.
"""

from __future__ import annotations

import json
import pathlib
import urllib.error
import urllib.parse
import urllib.request

HOMELAB = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = HOMELAB / ".env"
HEALTHCHECKS_ENV = HOMELAB / "config" / "healthchecks" / "ping-urls.env"
FIREFLY_URL = "http://127.0.0.1:8086"
API = f"{FIREFLY_URL}/api/v1"
DEFAULT_HEALTHCHECKS_URL = "http://127.0.0.1:8008"
DEFAULT_FINANCE_TOPIC = "1"
TELEGRAM_LIMIT = 3500
PAGE_SIZE = 200
PING_SUFFIX = {"start": "/start", "success": "", "fail": "/fail"}


def unquoted(value: str) -> str:
    """Strip one layer of matching surrounding quotes.

    Values containing spaces or JSON have to be quoted to survive `source .env`
    in the shell scripts, and JSON forces single quotes, so both styles arrive
    here. GHOSTFOLIO_ACCOUNT_MAP is the case that made this necessary.
    """
    text = value.strip()
    quoted = len(text) > 1 and text[0] == text[-1] and text[0] in "\"'"
    return text[1:-1] if quoted else text


def read_env(path: pathlib.Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        stripped = line.strip()
        usable = stripped and not stripped.startswith("#") and "=" in stripped
        if usable:
            key, _, value = stripped.partition("=")
            values[key.strip()] = unquoted(value)
    return values


ENV = read_env(ENV_FILE)
HC = read_env(HEALTHCHECKS_ENV) if HEALTHCHECKS_ENV.exists() else {}


def http(url: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def healthchecks_push(job_id: str, signal: str, message: str) -> None:
    key = HC.get("HEALTHCHECKS_PING_KEY")
    if not key:
        return
    base = HC.get("HEALTHCHECKS_BASE_URL", DEFAULT_HEALTHCHECKS_URL)
    try:
        http(
            f"{base}/ping/{key}/{job_id}{PING_SUFFIX[signal]}",
            method="POST",
            data=message.encode(),
            headers={"Content-Type": "text/plain; charset=utf-8"},
            timeout=10,
        )
    except OSError:
        pass


def telegram_send(text: str, topic: str | None = None) -> None:
    """Post to a forum topic. Defaults to the finance topic; pass `topic` to
    route elsewhere (e.g. the system topic for infrastructure jobs)."""
    token = ENV.get("TELEGRAM_BOT_TOKEN")
    chat = ENV.get("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return
    payload = urllib.parse.urlencode(
        {
            "chat_id": chat,
            "message_thread_id": topic or ENV.get("TELEGRAM_TOPIC_FINANCE", DEFAULT_FINANCE_TOPIC),
            "text": text[:TELEGRAM_LIMIT],
        }
    ).encode()
    try:
        http(f"https://api.telegram.org/bot{token}/sendMessage", method="POST", data=payload, timeout=10)
    except OSError:
        pass


class Firefly:
    def __init__(self) -> None:
        self.headers = {
            "Authorization": f"Bearer {ENV['FIREFLY_ACCESS_TOKEN']}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def call(self, method: str, path: str, payload: dict | None = None, params: dict | None = None) -> dict:
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        body = json.dumps(payload).encode() if payload is not None else None
        try:
            raw = http(f"{API}{path}{query}", method=method, data=body, headers=self.headers, timeout=60)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{method} {path} -> {exc.code}: {exc.read().decode()[:400]}") from exc
        return json.loads(raw) if raw else {}

    def paged(self, path: str, params: dict | None = None) -> list[dict]:
        collected = []
        page = 1
        while True:
            query = dict(params or {}, limit=PAGE_SIZE, page=page)
            response = self.call("GET", path, params=query)
            collected.extend(response["data"])
            pagination = response.get("meta", {}).get("pagination", {})
            page += 1
            if page > pagination.get("total_pages", 1):
                return collected
