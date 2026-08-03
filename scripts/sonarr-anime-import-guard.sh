#!/usr/bin/env bash
# Correct the narrow anime parser collision where "Movie 01" (or another
# numbered extra) is imported as episode 1 despite an explicit S01E01 sibling.

set -euo pipefail

log() {
  printf '[anime-import-guard] %s\n' "$*"
}

[[ "${sonarr_eventtype:-}" == "Download" ]] || exit 0
[[ "${sonarr_series_type,,}" == "anime" ]] || exit 0

source_path="${sonarr_episodefile_sourcepath:-}"
source_folder="${sonarr_episodefile_sourcefolder:-}"
destination_path="${sonarr_episodefile_path:-}"
episode_file_id="${sonarr_episodefile_id:-}"
season_number="${sonarr_episodefile_seasonnumber:-}"
episode_numbers="${sonarr_episodefile_episodenumbers:-}"
series_id="${sonarr_series_id:-}"

if [[ -z "$source_path" || -z "$source_folder" || -z "$destination_path" ||
      -z "$episode_file_id" || -z "$season_number" ||
      -z "$episode_numbers" || -z "$series_id" ]]; then
  log "download event is missing required per-file variables; leaving import unchanged"
  exit 0
fi

# Multi-episode imports are ambiguous and must never be changed automatically.
[[ "$episode_numbers" != *,* ]] || exit 0
[[ "$season_number" =~ ^[0-9]+$ && "$episode_numbers" =~ ^[0-9]+$ ]] || exit 0

source_name="${source_path##*/}"
source_name_lower="${source_name,,}"
extra_pattern='(^|[^[:alnum:]])(movie|ova|oad|special)[[:space:]._-]*0*([1-9][0-9]*)([^[:alnum:]]|$)'
[[ "$source_name_lower" =~ $extra_pattern ]] || exit 0

extra_number="${BASH_REMATCH[3]}"
(( 10#$extra_number == 10#$episode_numbers )) || exit 0

printf -v episode_token 's%02de%02d' "$season_number" "$episode_numbers"
candidate_paths=()
while IFS= read -r -d '' candidate; do
  candidate_name="${candidate##*/}"
  candidate_name_lower="${candidate_name,,}"
  case "$candidate_name_lower" in
    *.mkv|*.mp4|*.m4v|*.avi) ;;
    *) continue ;;
  esac

  if [[ "$candidate_name_lower" == *"$episode_token"* ]]; then
    candidate_paths+=("$candidate")
  fi
done < <(find "$source_folder" -maxdepth 2 -type f -print0)

if (( ${#candidate_paths[@]} != 1 )); then
  log "found ${#candidate_paths[@]} explicit $episode_token siblings for '$source_name'; leaving import unchanged"
  exit 0
fi

correct_source="${candidate_paths[0]}"
correct_destination="$(dirname "$destination_path")/${correct_source##*/}"

if [[ "${SONARR_IMPORT_GUARD_DRY_RUN:-false}" == "true" ]]; then
  log "would replace '$source_name' with '${correct_source##*/}' for $episode_token"
  exit 0
fi

[[ -f "$source_path" ]] || {
  log "source extra no longer exists; leaving import unchanged"
  exit 0
}
[[ -f "$destination_path" ]] || {
  log "imported extra no longer exists; leaving import unchanged"
  exit 0
}
[[ "$source_path" -ef "$destination_path" ]] || {
  log "imported extra is not a hardlink to its source; leaving import unchanged"
  exit 0
}

api_key="$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /config/config.xml)"
[[ -n "$api_key" ]] || {
  log "Sonarr API key is unavailable; leaving import unchanged"
  exit 0
}

# Remove the incorrect database mapping without asking Sonarr to delete the
# file. The source torrent remains untouched throughout.
curl -fsS -X DELETE \
  -H "X-Api-Key: $api_key" \
  "http://127.0.0.1:8989/api/v3/episodefile/${episode_file_id}?deleteFile=false"

# The imported extra is a hardlink/copy of the still-present torrent source.
rm -- "$destination_path"
if [[ ! -e "$correct_destination" ]]; then
  ln -- "$correct_source" "$correct_destination"
fi

curl -fsS -X POST \
  -H "X-Api-Key: $api_key" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"RescanSeries\",\"seriesId\":${series_id}}" \
  'http://127.0.0.1:8989/api/v3/command' >/dev/null

log "replaced '$source_name' with '${correct_source##*/}' for $episode_token; source pack preserved"
