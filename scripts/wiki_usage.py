#!/usr/bin/env python3
"""Local usage and error ledger for the wiki agent.

The ledger is JSONL under config/wiki-agent/state (gitignored). Prices are
estimates configured in .env; no network request is needed to meter a run.
"""

from __future__ import annotations

import argparse
import fcntl
import glob
import json
import os
import re
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


HOMELAB = Path(os.environ.get("HOMELAB", Path.home() / "homelab"))
VAULT = Path(os.environ.get("WIKI_VAULT", HOMELAB / "config" / "wiki-vault"))
STATE_DIR = HOMELAB / "config" / "wiki-agent" / "state"
LEDGER = STATE_DIR / "usage.jsonl"
CREDIT_SNAPSHOT = STATE_DIR / "credit.json"
OPENAI_COST_CACHE = STATE_DIR / "openai-costs.json"
OPENAI_COST_CACHE_SECONDS = 300

DEFAULT_PRICES = {
    "gpt-5.4-nano": {"input": 0.20, "cached_input": 0.02, "output": 1.25},
    "gpt-5.4-mini": {"input": 0.75, "cached_input": 0.075, "output": 4.50},
    "gpt-5.1": {"input": 1.25, "cached_input": 0.125, "output": 10.00},
}


def load_env(path: Path | None = None) -> dict[str, str]:
    path = path or HOMELAB / ".env"
    if not path.exists():
        return {}
    result = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def number(env: dict[str, str], key: str, default: float) -> float:
    try:
        return float(env.get(key, default))
    except (TypeError, ValueError):
        return default


class WikiUsage:
    def __init__(self, env: dict[str, str] | None = None, ledger: Path = LEDGER):
        self.env = env if env is not None else load_env()
        self.ledger = ledger
        self.usd_to_eur = number(self.env, "WIKI_USD_TO_EUR", 1.0)

    def prices(self, model: str) -> dict[str, float]:
        defaults = DEFAULT_PRICES.get(
            model,
            {
                "input": number(self.env, "WIKI_DEFAULT_INPUT_USD_PER_MTOK", 2.50),
                "cached_input": number(
                    self.env, "WIKI_DEFAULT_CACHED_INPUT_USD_PER_MTOK", 0.25
                ),
                "output": number(self.env, "WIKI_DEFAULT_OUTPUT_USD_PER_MTOK", 15.00),
            },
        )
        key = model.upper().replace("-", "_").replace(".", "_")
        return {
            part: number(
                self.env,
                f"WIKI_PRICE_{key}_{part.upper()}_USD_PER_MTOK",
                default,
            )
            for part, default in defaults.items()
        }

    def cost(self, model: str, usage: dict) -> tuple[float, float, float]:
        price = self.prices(model)
        input_tokens = int(usage.get("input_tokens", 0) or 0)
        cached = min(int(usage.get("cached_input_tokens", 0) or 0), input_tokens)
        uncached = max(input_tokens - cached, 0)
        output = int(usage.get("output_tokens", 0) or 0)
        cost_usd = (
            uncached * price["input"]
            + cached * price["cached_input"]
            + output * price["output"]
        ) / 1_000_000
        saved_usd = cached * (price["input"] - price["cached_input"]) / 1_000_000
        return cost_usd, cost_usd * self.usd_to_eur, saved_usd * self.usd_to_eur

    def read_events(self) -> list[dict]:
        if not self.ledger.exists():
            return []
        events = []
        with self.ledger.open() as handle:
            fcntl.flock(handle, fcntl.LOCK_SH)
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    events.append(event)
            fcntl.flock(handle, fcntl.LOCK_UN)
        return events

    def append(self, event: dict) -> bool:
        self.ledger.parent.mkdir(parents=True, exist_ok=True)
        event.setdefault("id", uuid.uuid4().hex)
        existing_ids = {item.get("id") for item in self.read_events()}
        if event["id"] in existing_ids:
            return False
        with self.ledger.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
            fcntl.flock(handle, fcntl.LOCK_UN)
        return True

    def credit_snapshot(self) -> dict | None:
        if not CREDIT_SNAPSHOT.exists():
            return None
        try:
            snapshot = json.loads(CREDIT_SNAPSHOT.read_text())
            balance = float(snapshot["balanceUsd"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None
        if balance < 0:
            return None
        result = {
            "balanceUsd": round(balance, 2),
            "checkedAt": snapshot.get("checkedAt"),
            "source": "manual",
        }
        if snapshot.get("lastTopUpUsd") is not None:
            result["lastTopUpUsd"] = round(float(snapshot["lastTopUpUsd"]), 2)
            result["lastTopUpAt"] = snapshot.get("lastTopUpAt")
        return result

    @staticmethod
    def _write_credit_snapshot(snapshot: dict) -> None:
        CREDIT_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        temporary = CREDIT_SNAPSHOT.with_suffix(".tmp")
        temporary.write_text(json.dumps(snapshot, indent=2) + "\n")
        os.replace(temporary, CREDIT_SNAPSHOT)

    def update_credit_snapshot(self, balance_usd: float) -> dict:
        balance = float(balance_usd)
        if balance < 0:
            raise ValueError("balance must be zero or greater")
        snapshot = {
            "balanceUsd": round(balance, 2),
            "checkedAt": datetime.now(timezone.utc).isoformat(),
        }
        self._write_credit_snapshot(snapshot)
        return self.credit_snapshot()

    def add_credit(self, amount_usd: float) -> dict:
        amount = float(amount_usd)
        if amount <= 0:
            raise ValueError("credit amount must be greater than zero")
        current = self.credit_snapshot()
        if not current:
            raise ValueError("set the current balance before recording a top-up")
        now = datetime.now(timezone.utc).isoformat()
        snapshot = {
            "balanceUsd": round(current["balanceUsd"] + amount, 2),
            "checkedAt": now,
            "lastTopUpUsd": round(amount, 2),
            "lastTopUpAt": now,
        }
        self._write_credit_snapshot(snapshot)
        return self.credit_snapshot()

    def openai_cost(self, force: bool = False) -> dict:
        """Return authoritative current-month organization/project spend.

        The Costs API requires an organization Admin API key. A short cache
        keeps opening the Obsidian drawer from issuing a network request every
        time while the explicit refresh path can bypass it.
        """
        admin_key = self.env.get("OPENAI_ADMIN_KEY") or self.env.get(
            "WIKI_OPENAI_ADMIN_KEY"
        )
        if not admin_key:
            return {
                "status": "not-configured",
                "source": "openai-costs-api",
                "message": "Add OPENAI_ADMIN_KEY to enable authoritative spend",
            }

        cached = None
        try:
            cached = json.loads(OPENAI_COST_CACHE.read_text())
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            pass
        if cached and not force:
            try:
                checked = datetime.fromisoformat(cached["checkedAt"])
                age = (datetime.now(timezone.utc) - checked).total_seconds()
                if age < OPENAI_COST_CACHE_SECONDS:
                    return cached
            except (KeyError, TypeError, ValueError):
                pass

        now = datetime.now(timezone.utc)
        period_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        params = {
            "start_time": int(period_start.timestamp()),
            "bucket_width": "1d",
            "limit": 31,
            "group_by": "line_item",
        }
        project_id = self.env.get("WIKI_OPENAI_COST_PROJECT_ID", "").strip()
        if project_id:
            params["project_ids"] = project_id
        url = "https://api.openai.com/v1/organization/costs?" + urllib.parse.urlencode(
            params
        )
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {admin_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.load(response)
            services = {
                "wikiAgent": 0.0,
                "karakeep": 0.0,
                "wikiTranscription": 0.0,
                "other": 0.0,
            }
            spend = 0.0
            for bucket in payload.get("data", []):
                for result in bucket.get("results", []):
                    amount = result.get("amount", {})
                    if amount.get("currency", "usd") != "usd":
                        continue
                    value = float(amount.get("value", 0) or 0)
                    line_item = str(result.get("line_item") or "")
                    spend += value
                    if line_item.startswith("gpt-4o-mini-transcribe"):
                        services["wikiTranscription"] += value
                    elif line_item.startswith("gpt-4o-mini-"):
                        services["karakeep"] += value
                    elif line_item.startswith("gpt-5"):
                        services["wikiAgent"] += value
                    else:
                        services["other"] += value
            snapshot = {
                "status": "ok",
                "spendUsd": round(spend, 4),
                "services": {
                    name: round(value, 6) for name, value in services.items()
                },
                "attribution": "model-line-item",
                "periodStart": period_start.date().isoformat(),
                "checkedAt": now.isoformat(),
                "scope": "project" if project_id else "organization",
                "source": "openai-costs-api",
            }
            OPENAI_COST_CACHE.parent.mkdir(parents=True, exist_ok=True)
            temporary = OPENAI_COST_CACHE.with_suffix(".tmp")
            temporary.write_text(json.dumps(snapshot, indent=2) + "\n")
            os.replace(temporary, OPENAI_COST_CACHE)
            return snapshot
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
            if cached and cached.get("spendUsd") is not None:
                return {
                    **cached,
                    "status": "stale",
                    "message": "OpenAI refresh failed; showing cached spend",
                }
            status = getattr(error, "code", None)
            return {
                "status": "error",
                "source": "openai-costs-api",
                "message": f"OpenAI Costs API returned HTTP {status}"
                if status
                else "OpenAI Costs API could not be reached",
            }

    @staticmethod
    def month_key(at: datetime | None = None) -> str:
        return (at or datetime.now(timezone.utc)).strftime("%Y-%m")

    def month_events(self, at: datetime | None = None) -> list[dict]:
        month = self.month_key(at)
        return [event for event in self.read_events() if str(event.get("timestamp", "")).startswith(month)]

    @staticmethod
    def sanitize_error(message: str) -> str:
        text = (message or "").strip()
        text = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "<redacted-api-key>", text)
        text = re.sub(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer <redacted>", text)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return "\n".join(lines[-8:])[-1200:] or "run failed without an error message"

    def record(self, *, kind: str, model: str, usage: dict, status: str,
               timestamp: str | None = None, run_id: str | None = None,
               source: str = "codex-json", error: str = "") -> bool:
        cost_usd, cost_eur, saved_eur = self.cost(model, usage)
        saved_usd = saved_eur / self.usd_to_eur if self.usd_to_eur else 0
        event = {
            "id": run_id or uuid.uuid4().hex,
            "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
            "kind": kind,
            "model": model,
            "status": status,
            "inputTokens": int(usage.get("input_tokens", 0) or 0),
            "cachedInputTokens": int(usage.get("cached_input_tokens", 0) or 0),
            "outputTokens": int(usage.get("output_tokens", 0) or 0),
            "reasoningOutputTokens": int(usage.get("reasoning_output_tokens", 0) or 0),
            "costUsd": round(cost_usd, 8),
            "costEur": round(cost_eur, 8),
            "cacheSavedEur": round(saved_eur, 8),
            "cacheSavedUsd": round(saved_usd, 8),
            "usdToEur": self.usd_to_eur,
            "source": source,
        }
        error and event.update({"error": self.sanitize_error(error)})
        return self.append(event)

    def record_failure(self, *, kind: str, model: str, status: str,
                       error: str, run_id: str | None = None) -> bool:
        return self.record(
            kind=kind,
            model=model,
            usage={},
            status=status,
            run_id=run_id,
            source="codex-error",
            error=error,
        )

    @staticmethod
    def usage_from_codex_json(text: str) -> dict | None:
        usages = []
        for line in text.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if item.get("type") == "turn.completed" and isinstance(item.get("usage"), dict):
                usages.append(item["usage"])
        if not usages:
            return None
        return {
            key: sum(int(usage.get(key, 0) or 0) for usage in usages)
            for key in (
                "input_tokens",
                "cached_input_tokens",
                "output_tokens",
                "reasoning_output_tokens",
            )
        }

    @staticmethod
    def error_from_codex_json(text: str) -> str:
        messages = []
        for line in text.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if item.get("type") == "error":
                messages.append(str(item.get("message") or item.get("error") or ""))
            elif item.get("type") == "turn.failed":
                error = item.get("error") or {}
                messages.append(str(error.get("message") if isinstance(error, dict) else error))
        return "\n".join(message for message in messages if message)

    def record_codex_output(self, text: str, **metadata) -> bool:
        usage = self.usage_from_codex_json(text)
        return bool(usage) and self.record(usage=usage, **metadata)

    def pending_counts(self) -> dict:
        inbox = [
            path
            for path in (VAULT / "inbox").glob("*.md")
            if path.name != "podcasts.md"
        ]
        missing_sources = [
            path
            for path in (VAULT / "system" / "raw").glob("*/*.md")
            if not (VAULT / "wiki" / "sources" / path.name).exists()
        ]
        gaps = list((VAULT / "inbox" / "research-gaps").glob("*.md"))
        return {
            "inbox": len(inbox),
            "rawSources": len(missing_sources),
            "researchGaps": len(gaps),
        }

    def summary(self, at: datetime | None = None) -> dict:
        now = at or datetime.now(timezone.utc)
        all_events = self.read_events()
        month = self.month_key(now)
        events = [
            event for event in all_events
            if str(event.get("timestamp", "")).startswith(month)
        ]
        spent = sum(float(event.get("costEur", 0) or 0) for event in events)
        spent_usd = sum(float(event.get("costUsd", 0) or 0) for event in events)
        saved = sum(float(event.get("cacheSavedEur", 0) or 0) for event in events)
        saved_usd = sum(
            float(event.get("cacheSavedUsd", 0) or 0)
            or float(event.get("cacheSavedEur", 0) or 0)
            / max(float(event.get("usdToEur", 1) or 1), 0.000001)
            for event in events
        )
        by_kind = defaultdict(
            lambda: {"runs": 0, "costEur": 0.0, "costUsd": 0.0, "tokens": 0}
        )
        for event in events:
            row = by_kind[event.get("kind", "unknown")]
            row["runs"] += 1
            row["costEur"] += float(event.get("costEur", 0) or 0)
            row["costUsd"] += float(event.get("costUsd", 0) or 0)
            row["tokens"] += int(event.get("inputTokens", 0) or 0) + int(
                event.get("outputTokens", 0) or 0
            )
        total_spent = sum(float(event.get("costEur", 0) or 0) for event in all_events)
        total_spent_usd = sum(float(event.get("costUsd", 0) or 0) for event in all_events)
        latest_by_kind = {}
        for event in all_events:
            latest_by_kind[event.get("kind", "unknown")] = event
        failures = [
            event
            for event in latest_by_kind.values()
            if event.get("status") != "completed"
        ]
        failures.sort(key=lambda event: event.get("timestamp", ""), reverse=True)
        return {
            "month": self.month_key(now),
            "spentEur": round(spent, 4),
            "totalSpentEur": round(total_spent, 4),
            "cacheSavedEur": round(saved, 4),
            "spentUsd": round(spent_usd, 4),
            "totalSpentUsd": round(total_spent_usd, 4),
            "cacheSavedUsd": round(saved_usd, 4),
            "runs": len(events),
            "byKind": {
                kind: {
                    **row,
                    "costEur": round(row["costEur"], 4),
                    "costUsd": round(row["costUsd"], 4),
                }
                for kind, row in sorted(by_kind.items(), key=lambda item: -item[1]["costUsd"])
            },
            "credit": self.credit_snapshot(),
            "recentFailures": failures,
            "pending": self.pending_counts(),
            "estimated": True,
            "usdToEur": self.usd_to_eur,
        }

    def backfill_sessions(self, root: Path) -> int:
        added = 0
        for path_text in glob.glob(str(root / "**" / "*.jsonl"), recursive=True):
            path = Path(path_text)
            session_id = None
            timestamp = None
            model = ""
            prompts = []
            usage = None
            completed = False
            for line in path.read_text(errors="replace").splitlines():
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = item.get("payload", {})
                if item.get("type") == "session_meta":
                    session_id = payload.get("session_id") or payload.get("id")
                    timestamp = payload.get("timestamp") or item.get("timestamp")
                elif item.get("type") == "turn_context":
                    model = payload.get("model", model)
                elif (
                    item.get("type") == "response_item"
                    and payload.get("type") == "message"
                    and payload.get("role") == "user"
                ):
                    prompts.append(
                        "\n".join(
                            part.get("text", "")
                            for part in payload.get("content", [])
                            if part.get("type") == "input_text"
                        )
                    )
                elif item.get("type") == "event_msg" and payload.get("type") == "token_count":
                    candidate = payload.get("info", {}).get("total_token_usage")
                    candidate and (usage := candidate)
                elif item.get("type") == "event_msg" and payload.get("type") == "task_complete":
                    completed = True
            if not session_id or not usage or not model:
                continue
            prompt = prompts[-1].lower() if prompts else ""
            kind = next(
                (name for name in ("enrich-note", "ingest-inbox", "refresh-moc", "lint-wiki") if name in prompt),
                "ask" if "answer-question" in prompt else "unknown",
            )
            if kind == "unknown":
                continue
            if self.record(
                kind=kind,
                model=model,
                usage=usage,
                status="completed" if completed else "interrupted",
                timestamp=timestamp,
                run_id=f"session:{session_id}",
                source="codex-session-backfill",
            ):
                added += 1
        return added


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    record = sub.add_parser("record")
    record.add_argument("--kind", required=True)
    record.add_argument("--model", required=True)
    record.add_argument("--json-log", type=Path, required=True)
    record.add_argument("--status", default="completed")
    record.add_argument("--run-id")
    record.add_argument("--error-log", type=Path)
    sub.add_parser("summary")
    backfill = sub.add_parser("backfill-sessions")
    backfill.add_argument("--root", type=Path, default=HOMELAB / "config/wiki-agent/codex-home/sessions")
    args = parser.parse_args()
    usage_ledger = WikiUsage()
    if args.command == "record":
        text = args.json_log.read_text(errors="replace")
        error = args.error_log.read_text(errors="replace") if args.error_log else ""
        error = error or usage_ledger.error_from_codex_json(text)
        recorded = usage_ledger.record_codex_output(
            text,
            kind=args.kind,
            model=args.model,
            status=args.status,
            run_id=args.run_id,
            error=error if args.status != "completed" else "",
        )
        if not recorded and args.status != "completed":
            recorded = usage_ledger.record_failure(
                kind=args.kind,
                model=args.model,
                status=args.status,
                error=error,
                run_id=args.run_id,
            )
        if not recorded:
            print("wiki usage: no token usage found in Codex JSON", file=sys.stderr)
        return 0
    if args.command == "summary":
        print(json.dumps(usage_ledger.summary(), indent=2))
        return 0
    if args.command == "backfill-sessions":
        print(f"backfilled {usage_ledger.backfill_sessions(args.root)} sessions")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
