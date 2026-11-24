#!/bin/sh
# CI calls this before dependency installation. Keep the blobless history/refspec
# intact and avoid HTTP/2 framing failures. Callers bound this step to 4 minutes.
#
# MAIN-HISTORY MIRROR CACHE (CACHE-1, interface forge.build-storage). With MAIN_HISTORY_CACHE_DIR set:
#   - `fetch-main-history.sh` seeds the repo from a cached pack of main's commits and trees, but only
#     after proving every commit and tree reachable from the recorded tip is present (rev-list with
#     --missing=error). Anything else is discarded and the full blobless fetch runs, so a stale,
#     partial or corrupt cache can never be used. The live fetch then ALWAYS runs on top.
#   - `fetch-main-history.sh save` (main pushes only, one job) writes the pack and tip sha there,
#     failing closed: nothing is published unless the export and the pack both succeeded.
set -eu

cache="${MAIN_HISTORY_CACHE_DIR:-}"

if [ "${1:-}" = "save" ]; then
  [ -n "$cache" ] || { echo "ci: save needs MAIN_HISTORY_CACHE_DIR" >&2; exit 1; }
  tip=$(git rev-parse --verify --end-of-options 'refs/remotes/origin/main^{commit}')
  work="$cache.tmp"
  rm -f "$work".*
  mkdir -p "$(dirname "$cache")"
  git rev-list --objects --filter=blob:none --missing=error "$tip" > "$work.list"
  mkdir -p "$work.d"
  git pack-objects "$work.d/pack" < "$work.list" > /dev/null
  rm -rf "$cache"
  mv "$work.d" "$cache"
  rm -f "$work.list"
  printf '%s\n' "$tip" > "$cache/sha"
  exit 0
fi

discard() {
  for base in $seeded; do rm -f "$packdir/$base.pack" "$packdir/$base.idx" "$packdir/$base.promisor"; done
  echo "ci: cached main history unusable; discarding and doing the full fetch" >&2
}

copy_packs() {
  for base in $seeded; do
    cp "$cache/$base.pack" "$cache/$base.idx" "$packdir/" || return 1
    : > "$packdir/$base.promisor" || return 1
  done
}

seeded=""
if [ -n "$cache" ] && [ -f "$cache/sha" ] && ls "$cache"/pack-*.pack >/dev/null 2>&1; then
  packdir=$(git rev-parse --git-path objects/pack)
  tip=$(cat "$cache/sha")
  mkdir -p "$packdir"
  for f in "$cache"/pack-*.pack; do seeded="$seeded $(basename "$f" .pack)"; done
  if copy_packs &&
     git rev-list --objects --filter=blob:none --missing=error "$tip" > /dev/null &&
     git update-ref refs/remotes/origin/main "$tip"; then
    echo "ci: seeded main history from cache ($tip)"
  else
    discard
  fi
fi

for attempt in 1 2 3; do
  if git -c http.version=HTTP/1.1 fetch --no-tags --filter=blob:none --depth=1000000 origin '+refs/heads/main:refs/remotes/origin/main'; then
    exit 0
  else
    status=$?
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "ci: main history fetch failed after 3 attempts; refusing unavailable history" >&2
    exit "$status"
  fi
  delay=$((attempt * 5))
  echo "ci: main history fetch attempt $attempt failed; retrying in ${delay}s" >&2
  sleep "$delay"
done
