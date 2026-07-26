#!/usr/bin/env bash
# Wiki podcast/video intake (docs/wiki-system.md).
# Scans inbox/podcasts.md for unchecked `- [ ] <url>` lines: downloads audio
# (yt-dlp), transcodes + segments (ffmpeg, 20-min mono 32k mp3 chunks to stay
# under the STT API caps), transcribes (OpenAI gpt-4o-mini-transcribe), writes
# the transcript to system/raw/YYYY/ + an inbox pointer, then checks the line off.
# A failed URL is marked `- [!]` with the error, and never retried silently.
set -euo pipefail

# Homebrew prefix differs by architecture; launchd jobs get no login shell.
for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "${brew_bin}" ] && eval "$("${brew_bin}" shellenv)" && break
done

HOMELAB="${HOMELAB:-${HOME}/homelab}"
cd "${HOMELAB}"
set -a; source .env; set +a

sleep "${WIKI_SETTLE:-180}"
export OPENAI_KEY="${WIKI_OPENAI_API_KEY:-${KARAKEEP_OPENAI_API_KEY}}"

fail() { "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_WIKI_PODCAST down "podcast transcribe failed" || true; }
trap fail ERR
"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_WIKI_PODCAST start "podcast transcription started" || true

RESULT="$(python3 - <<'PY'
import datetime, json, os, re, shutil, subprocess, sys, tempfile, urllib.request

VAULT = os.environ.get("WIKI_VAULT") or os.path.join(os.environ["HOME"], "homelab", "config", "wiki-vault")
LIST = os.path.join(VAULT, "inbox", "podcasts.md")
KEY = os.environ["OPENAI_KEY"]

if not os.path.exists(LIST):
    print("DONE=0 (no podcasts.md)")
    sys.exit(0)

lines = open(LIST).read().splitlines()
pending = [(i, m.group(1)) for i, l in enumerate(lines)
           if (m := re.match(r"^- \[ \] +(\S+)", l))]
if not pending:
    print("DONE=0")
    sys.exit(0)

def transcribe(path):
    boundary = "----wikiB0undary"
    body = b""
    for name, val in (("model", "gpt-4o-mini-transcribe"), ("response_format", "text")):
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n").encode()
    body += open(path, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
    r = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions",
        data=body, headers={"Authorization": "Bearer " + KEY,
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(r, timeout=600) as resp:
        return resp.read().decode().strip()

done = failed = 0
today = datetime.date.today().isoformat()
for idx, url in pending:
    tmp = tempfile.mkdtemp(prefix="wikipod-")
    try:
        meta = json.loads(subprocess.run(
            ["yt-dlp", "-J", "--no-playlist", url],
            capture_output=True, check=True).stdout)
        title = meta.get("title") or url
        upload = meta.get("upload_date") or ""
        date = f"{upload[:4]}-{upload[4:6]}-{upload[6:8]}" if len(upload) == 8 else today
        subprocess.run(["yt-dlp", "--no-playlist", "-x", "-o",
                        os.path.join(tmp, "audio.%(ext)s"), url],
                       capture_output=True, check=True)
        src = next(os.path.join(tmp, f) for f in os.listdir(tmp) if f.startswith("audio."))
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", src,
                        "-ac", "1", "-b:a", "32k", "-f", "segment",
                        "-segment_time", "1200",
                        os.path.join(tmp, "seg%03d.mp3")], check=True)
        segs = sorted(f for f in os.listdir(tmp) if f.startswith("seg"))
        text = "\n\n".join(transcribe(os.path.join(tmp, s)) for s in segs)
        slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", title.lower())).strip("-")[:60] or "episode"
        raw_rel = f"system/raw/{date[:4]}/{date}-{slug}.md"
        raw_path = os.path.join(VAULT, raw_rel)
        os.makedirs(os.path.dirname(raw_path), exist_ok=True)
        front = "\n".join(["---", f"title: {json.dumps(title)}", f"url: {json.dumps(url)}",
            "kind: podcast-transcript",
            f"duration_s: {int(meta.get('duration') or 0)}",
            f"transcribed: {today}", "---"])
        with open(raw_path, "w") as f:
            f.write(front + f"\n\n# {title} (transcript)\n\n" + text + "\n")
        with open(os.path.join(VAULT, "inbox", f"{date}-{slug}.md"), "w") as f:
            f.write(f"New podcast transcript: {title}\n\nFull text: {raw_rel}\n")
        lines[idx] = lines[idx].replace("- [ ]", "- [x]", 1)
        done += 1
        print(f"transcribed: {raw_rel}", file=sys.stderr)
    except Exception as e:
        detail = e.stderr.decode()[:120] if hasattr(e, "stderr") and e.stderr else str(e)[:120]
        lines[idx] = lines[idx].replace("- [ ]", "- [!]", 1) + f"  <!-- failed: {detail} -->"
        failed += 1
        print(f"FAILED {url}: {detail}", file=sys.stderr)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    open(LIST, "w").write("\n".join(lines) + "\n")

print(f"DONE={done} FAILED={failed}")
sys.exit(1 if failed and not done else 0)
PY
)"

echo "${RESULT}"
"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_WIKI_PODCAST up "${RESULT}" || true
