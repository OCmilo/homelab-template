#!/usr/bin/env python3
"""Ask the wiki — HTTP bridge between the dashboard plugin and a read-only Codex run.

POST /ask {"question": "...", "thread": [{"question","answer"}, ...]} -> {"id"}
GET  /ask/<id> -> {"status": "running|done|error", "answer", "elapsed"}
GET  /health -> {"ok": true}

Read-only by construction: codex runs with --sandbox read-only, so a prompt
injection or model mistake cannot touch the vault. Bypasses the wiki-agent
run lock on purpose — answering writes nothing, so it never conflicts.
"""
import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from wiki_usage import WikiUsage

HOMELAB = Path.home() / "homelab"
VAULT = Path(os.environ.get("WIKI_VAULT", str(HOMELAB / "config" / "wiki-vault")))
SKILL = HOMELAB / "config" / "wiki-agent" / "skills" / "answer-question.md"
POLICY = HOMELAB / "config" / "wiki-agent" / "skills" / "untrusted-content-policy.md"
CODEX_HOME = HOMELAB / "config" / "wiki-agent" / "codex-home"
PORT = 8799
MAX_THREAD_TURNS = 4
JOB_TTL_SECONDS = 3600

jobs = {}
jobs_lock = threading.Lock()


def load_env():
    entries = (HOMELAB / ".env").read_text().splitlines()
    pairs = [line.split("=", 1) for line in entries if "=" in line and not line.startswith("#")]
    return {key.strip(): value.strip().strip('"') for key, value in pairs}


ENV_FILE = load_env()
MODEL = ENV_FILE.get("WIKI_MODEL_SYNTH", "gpt-5.4-mini")
API_KEY = ENV_FILE.get("WIKI_OPENAI_API_KEY") or ENV_FILE.get("KARAKEEP_OPENAI_API_KEY", "")
USAGE = WikiUsage(ENV_FILE)


def ops_summary(force_cost=False):
    summary = USAGE.summary()
    summary["openaiCost"] = USAGE.openai_cost(force=force_cost)
    with jobs_lock:
        summary["activeAskJobs"] = sum(job["status"] == "running" for job in jobs.values())
    return summary


def build_prompt(question, thread):
    policy_text = POLICY.read_text()
    skill_text = SKILL.read_text()
    turns = thread[-MAX_THREAD_TURNS:]
    history = "\n\n".join(
        f"Earlier question: {turn['question']}\nEarlier answer:\n{turn['answer']}" for turn in turns
    )
    thread_block = history and f"\n\n## Conversation so far\n\n{history}\n"
    return (
        f"{policy_text}\n\n---\n\n{skill_text}{thread_block or ''}"
        f"\n\n## Question\n\n{question}\n"
    )


def run_job(job_id, question, thread):
    started = time.time()
    with tempfile.NamedTemporaryFile(mode="r", suffix=".md", delete=False) as last_message:
        output_path = last_message.name
    command = [
        "codex",
        "--ask-for-approval", "never",
        "-c", "sandbox_workspace_write.network_access=false",
        "-c", 'web_search="disabled"',
        "exec",
        "-C", str(VAULT),
        "--model", MODEL,
        "--sandbox", "read-only",
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        "--output-last-message", output_path,
        build_prompt(question, thread),
    ]
    run_env = {
        "HOME": str(Path.home()),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "CODEX_HOME": str(CODEX_HOME),
        "OPENAI_API_KEY": API_KEY,
    }
    try:
        result = subprocess.run(
            command,
            env=run_env,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except subprocess.TimeoutExpired as error:
        partial = error.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode(errors="replace")
        recorded = USAGE.record_codex_output(
            partial,
            kind="ask",
            model=MODEL,
            status="timed-out",
            run_id=f"ask:{job_id}",
            error=str(error),
        )
        if not recorded:
            USAGE.record_failure(
                kind="ask",
                model=MODEL,
                status="timed-out",
                error=str(error),
                run_id=f"ask:{job_id}",
            )
        Path(output_path).unlink(missing_ok=True)
        raise
    recorded = USAGE.record_codex_output(
        result.stdout,
        kind="ask",
        model=MODEL,
        status="completed" if result.returncode == 0 else "failed",
        run_id=f"ask:{job_id}",
        error=(result.stderr or USAGE.error_from_codex_json(result.stdout))
        if result.returncode != 0 else "",
    )
    if not recorded and result.returncode != 0:
        USAGE.record_failure(
            kind="ask",
            model=MODEL,
            status="failed",
            error=result.stderr or USAGE.error_from_codex_json(result.stdout),
            run_id=f"ask:{job_id}",
        )
    elif not recorded:
        print(f"wiki usage: no token totals for ask:{job_id}", flush=True)
    answer = Path(output_path).read_text().strip()
    Path(output_path).unlink(missing_ok=True)
    ok = result.returncode == 0 and answer
    with jobs_lock:
        jobs[job_id] = {
            "status": "done" if ok else "error",
            "answer": answer if ok else "",
            "error": "" if ok else USAGE.sanitize_error(
                result.stderr or USAGE.error_from_codex_json(result.stdout)
            )[-500:],
            "elapsed": round(time.time() - started, 1),
            "created": jobs[job_id]["created"],
        }


def prune_jobs():
    cutoff = time.time() - JOB_TTL_SECONDS
    with jobs_lock:
        stale = [job_id for job_id, job in jobs.items() if job["created"] < cutoff]
        [jobs.pop(job_id) for job_id in stale]


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            return self.reply(200, {"ok": True, "model": MODEL})
        if parsed.path == "/ops":
            force = parse_qs(parsed.query).get("refresh", ["0"])[0] == "1"
            return self.reply(200, ops_summary(force_cost=force))
        job_id = parsed.path.rsplit("/", 1)[-1]
        with jobs_lock:
            job = jobs.get(job_id)
        job or self.reply(404, {"error": "unknown job"})
        job and self.reply(200, {key: value for key, value in job.items() if key != "created"})

    def do_POST(self):
        if self.path == "/ops/credit/add":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                USAGE.add_credit(payload.get("amountUsd"))
            except (json.JSONDecodeError, TypeError, ValueError) as error:
                return self.reply(400, {"error": str(error) or "invalid credit amount"})
            return self.reply(200, ops_summary())
        if self.path == "/ops/credit":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                USAGE.update_credit_snapshot(payload.get("balanceUsd"))
            except (json.JSONDecodeError, TypeError, ValueError) as error:
                return self.reply(400, {"error": str(error) or "invalid credit snapshot"})
            return self.reply(200, ops_summary())
        if self.path == "/ops/retry":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self.reply(400, {"error": "invalid JSON"})
            kind = payload.get("kind")
            allowed = {"enrich-note", "ingest-inbox", "refresh-moc", "lint-wiki"}
            if kind not in allowed:
                return self.reply(400, {"error": "workflow is not retryable here"})
            log_path = HOMELAB / "config" / "wiki-agent-launchd.log"
            with log_path.open("a") as log:
                subprocess.Popen(
                    [str(HOMELAB / "scripts" / "wiki-agent.sh"), kind, "--retry"],
                    cwd=HOMELAB,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            return self.reply(202, {"ok": True, "kind": kind})
        if self.path != "/ask":
            return self.reply(404, {"error": "unknown route"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self.reply(400, {"error": "invalid JSON"})
        question = (payload.get("question") or "").strip()
        question or self.reply(400, {"error": "question required"})
        if not question:
            return
        prune_jobs()
        job_id = uuid.uuid4().hex[:12]
        with jobs_lock:
            jobs[job_id] = {"status": "running", "answer": "", "error": "", "elapsed": 0, "created": time.time()}
        thread = payload.get("thread") or []
        worker = threading.Thread(
            target=self.safe_run,
            args=(job_id, question, thread),
            daemon=True,
        )
        worker.start()
        self.reply(202, {"id": job_id})

    @staticmethod
    def safe_run(job_id, question, thread):
        try:
            run_job(job_id, question, thread)
        except Exception as error:
            USAGE.record_failure(
                kind="ask",
                model=MODEL,
                status="failed",
                error=str(error),
                run_id=f"ask:{job_id}",
            )
            with jobs_lock:
                jobs[job_id].update({
                    "status": "error",
                    "error": USAGE.sanitize_error(str(error))[-500:],
                })

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


def main():
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
