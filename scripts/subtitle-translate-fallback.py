#!/usr/bin/env python3
# Fallback subtitle translator: for media that has an English subtitle but is still
# missing a target language after a grace period, machine-translate from English via
# Bazarr. Runs one translation at a time (waits for each output file before the next)
# so it never exhausts connections/file descriptors. Idempotent: skips languages whose
# file already exists. Reads the Bazarr API key from the gitignored config at runtime.
# Grace period is configurable via SUBTRANS_GRACE_DAYS (default 5).
import json, urllib.request, urllib.parse, os, time, subprocess, sys

CFG = os.path.expanduser("~/homelab/config/bazarr/config/config.yaml")
HOMELAB = os.path.expanduser("~/homelab")
BASE = "http://127.0.0.1:6767/api"
GRACE_DAYS = int(os.environ.get("SUBTRANS_GRACE_DAYS", "5"))
LANGS = ("es", "pb")
TAG = {"es": "es", "pb": "pt-BR"}
DATA_CT = "/data"
DATA_HOST = os.path.expanduser("~/MediaData")
NOW = time.time()
POLL_TRIES, POLL_SLEEP = 60, 3

def bazarr_apikey():
    in_auth = False
    for line in open(CFG):
        if line.rstrip() == "auth:":
            in_auth = True
            continue
        if in_auth:
            if line[:1] not in (" ", "\t"):
                break
            s = line.strip()
            if s.startswith("apikey:"):
                return s.split(":", 1)[1].strip().strip("\x27\"")
    raise SystemExit("Bazarr apikey not found in config")

H = {"X-API-KEY": bazarr_apikey()}

def kuma_push(status, message):
    subprocess.run(
        [os.path.join(HOMELAB, "scripts/kuma-push.sh"), "KUMA_PUSH_SUBTITLE_TRANSLATE", status, message],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

def report_unhandled(exc_type, exc, tb):
    kuma_push("down", "subtitle fallback failed")
    sys.__excepthook__(exc_type, exc, tb)

sys.excepthook = report_unhandled
kuma_push("start", "subtitle fallback started")

def log(m):
    print("%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), m), flush=True)

def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=30) as r:
        d = json.loads(r.read().decode())
    return d.get("data", d) if isinstance(d, dict) else d

def submit(subpath, lang, typ, mid, video):
    body = urllib.parse.urlencode({"action": "translate", "language": lang, "path": subpath,
        "type": typ, "id": mid, "forced": "false", "hi": "false",
        "original_format": "true", "video_path": video}).encode()
    req = urllib.request.Request(BASE + "/subtitles", data=body, method="PATCH",
        headers={**H, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.status

def hostpath(p):
    return p.replace(DATA_CT, DATA_HOST, 1)

def out_file(video, lang):
    return os.path.splitext(hostpath(video))[0] + "." + TAG[lang] + ".srt"

def old_enough(video):
    try:
        return (NOW - os.path.getmtime(hostpath(video))) >= GRACE_DAYS * 86400
    except OSError:
        return True

def handle(item, typ, idkey, label):
    en = [s for s in (item.get("subtitles") or []) if s.get("code2") == "en" and s.get("path")]
    if not en or not old_enough(item.get("path", "")):
        return 0
    n = 0
    for lang in LANGS:
        target = out_file(item["path"], lang)
        if os.path.exists(target):
            continue
        try:
            submit(en[0]["path"], lang, typ, item[idkey], item["path"])
        except Exception as ex:
            log("FAIL submit %s -> %s : %s" % (label, lang, str(ex)[:70]))
            continue
        ok = False
        for _ in range(POLL_TRIES):
            if os.path.exists(target):
                ok = True
                break
            time.sleep(POLL_SLEEP)
        log(("translated " if ok else "TIMEOUT ") + "%s -> %s" % (label, lang))
        n += 1 if ok else 0
    return n

count = 0
for s in get("/series?start=0&length=10000"):
    for e in get("/episodes?seriesid[]=%d" % s.get("sonarrSeriesId")):
        count += handle(e, "episode", "sonarrEpisodeId",
                        "%s S%02dE%02d" % (s.get("title"), e.get("season") or 0, e.get("episode") or 0))
for m in get("/movies?start=0&length=10000"):
    count += handle(m, "movie", "radarrId", m.get("title"))
log("fallback translation run complete: %d generated (grace=%dd, langs=%s)" % (count, GRACE_DAYS, ",".join(LANGS)))

for _task in ("series_full_scan_subtitles", "movies_full_scan_subtitles"):
    try:
        urllib.request.urlopen(urllib.request.Request(BASE + "/system/tasks?taskid=" + _task, method="POST", headers=H), timeout=15)
    except Exception:
        pass
log("triggered Bazarr subtitle re-index")
kuma_push("up", "subtitle fallback ok: %d generated" % count)
