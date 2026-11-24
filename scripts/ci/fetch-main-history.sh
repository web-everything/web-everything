#!/bin/sh
# CI calls this before dependency installation. Keep the blobless history/refspec
# intact and avoid HTTP/2 framing failures. Callers bound this step to 4 minutes.
#
# MAIN-HISTORY MIRROR CACHE (CACHE-1). With MAIN_HISTORY_CACHE_DIR set:
#   - `fetch-main-history.sh` seeds the repo from a cached pack of main's commits and trees (if the
#     cache dir holds one and the recorded tip commit is readable), then ALWAYS runs the live fetch,
#     which only transfers what is newer. A missing or corrupt cache is discarded and the full
#     blobless fetch runs as before, so a stale or bad cache cannot change correctness.
#   - `fetch-main-history.sh save` (main pushes only, one job) writes the pack and tip sha there.
set -eu

cache="${MAIN_HISTORY_CACHE_DIR:-}"

if [ "${1:-}" = "save" ]; then
  [ -n "$cache" ] || { echo "ci: save needs MAIN_HISTORY_CACHE_DIR" >&2; exit 1; }
  mkdir -p "$cache"
  tip=$(git rev-parse --verify --end-of-options 'refs/remotes/origin/main^{commit}')
  git rev-list --objects --filter=blob:none --missing=allow-any "$tip" | git pack-objects "$cache/pack" >/dev/null
  printf '%s\n' "$tip" > "$cache/sha"
  exit 0
fi

seeded=""
if [ -n "$cache" ] && [ -f "$cache/sha" ] && ls "$cache"/pack-*.pack >/dev/null 2>&1; then
  packdir=$(git rev-parse --git-path objects/pack)
  tip=$(cat "$cache/sha")
  mkdir -p "$packdir"
  for f in "$cache"/pack-*.pack; do
    base=$(basename "$f" .pack)
    cp "$cache/$base.pack" "$cache/$base.idx" "$packdir/" && : > "$packdir/$base.promisor" && seeded="$seeded $base"
  done
  if git cat-file -e "$tip^{commit}" && git update-ref refs/remotes/origin/main "$tip"; then
    echo "ci: seeded main history from cache ($tip)"
  else
    echo "ci: cached main history unusable; discarding and doing the full fetch" >&2
    for base in $seeded; do rm -f "$packdir/$base.pack" "$packdir/$base.idx" "$packdir/$base.promisor"; done
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
