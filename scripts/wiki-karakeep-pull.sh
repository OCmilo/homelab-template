#!/usr/bin/env bash
# Wiki Karakeep intake (docs/wiki-system.md).
# Pulls bookmarks tagged `wiki` that lack `wiki-synced`: full text (pandoc
# HTML->markdown) lands in system/raw/YYYY/, a pointer note in inbox/, then the
# bookmark gets `wiki-synced`. The `wiki` tag is the manual send action; each
# bookmark is pulled exactly once. Bookmarks whose crawl hasn't finished are
# left untouched for the next run. Exits quietly when nothing is pending.
set -euo pipefail

# Homebrew prefix differs by architecture; launchd jobs get no login shell.
for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "${brew_bin}" ] && eval "$("${brew_bin}" shellenv)" && break
done

HOMELAB="${HOMELAB:-${HOME}/homelab}"
cd "${HOMELAB}"
set -a; source .env; set +a

fail() { "${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_WIKI_KARAKEEP down "karakeep pull failed" || true; }
trap fail ERR
"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_WIKI_KARAKEEP start "karakeep pull started" || true

RESULT="$(python3 - <<'PY'
import datetime, json, os, re, subprocess, sys, urllib.parse, urllib.request

API = "http://localhost:3002/api/v1"
TOKEN = os.environ["KARAKEEP_API_TOKEN"]
VAULT = os.environ.get("WIKI_VAULT") or os.path.join(os.environ["HOME"], "homelab", "config", "wiki-vault")

def req(path, method="GET", body=None):
    r = urllib.request.Request(API + path, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.load(resp)

tags = {t["name"]: t["id"] for t in req("/tags")["tags"]}
wiki_id = tags.get("wiki")
if not wiki_id:
    print("PULLED=0 (no `wiki` tag in Karakeep yet)")
    sys.exit(0)

bookmarks, cursor = [], None
while True:
    q = f"/tags/{wiki_id}/bookmarks?limit=50&includeContent=true"
    if cursor:
        q += "&cursor=" + urllib.parse.quote(cursor)
    page = req(q)
    bookmarks += page["bookmarks"]
    cursor = page.get("nextCursor")
    if not cursor:
        break

pulled = deferred = 0
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
for b in bookmarks:
    if any(t["name"] == "wiki-synced" for t in b.get("tags", [])):
        continue
    c = b.get("content") or {}
    if c.get("type") == "link" and c.get("crawlStatus") not in ("success", "failure"):
        deferred += 1
        continue
    title = (b.get("title") or c.get("title") or "untitled").strip()
    created = (b.get("createdAt") or "")[:10] or datetime.date.today().isoformat()
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", title.lower())).strip("-")[:60] or b["id"]
    raw_rel = f"system/raw/{created[:4]}/{created}-{slug}.md"
    raw_path = os.path.join(VAULT, raw_rel)
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    if not os.path.exists(raw_path):
        html = c.get("htmlContent") or ""
        if html:
            md = subprocess.run(
                ["pandoc", "-f", "html", "-t", "gfm-raw_html", "--wrap=none"],
                input=html.encode(), capture_output=True, check=True,
            ).stdout.decode()
        else:
            md = "(Karakeep stored no page content — crawl failed; only the URL is available.)"
        front = "\n".join([
            "---",
            f"title: {json.dumps(title)}",
            f"url: {json.dumps(c.get('url') or '')}",
            f"author: {json.dumps(c.get('author') or '')}",
            f"published: {json.dumps(c.get('datePublished') or '')}",
            f"karakeep: {b['id']}",
            f"pulled: {now}",
            "---",
        ])
        with open(raw_path, "w") as f:
            f.write(front + "\n\n# " + title + "\n\n" + md + "\n")
    pointer = os.path.join(VAULT, "inbox", f"{created}-{slug}.md")
    if not os.path.exists(pointer):
        with open(pointer, "w") as f:
            f.write(f"New source pulled from Karakeep: {title}\n\nFull text: {raw_rel}\n")
    req(f"/bookmarks/{b['id']}/tags", "POST", {"tags": [{"tagName": "wiki-synced"}]})
    pulled += 1
    print(f"pulled: {raw_rel}", file=sys.stderr)

print(f"PULLED={pulled} DEFERRED={deferred}")
PY
)"

echo "${RESULT}"
"${HOMELAB}/scripts/kuma-push.sh" KUMA_PUSH_WIKI_KARAKEEP up "${RESULT}" || true
