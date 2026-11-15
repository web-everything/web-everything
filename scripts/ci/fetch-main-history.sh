#!/bin/sh
# CI calls this before dependency installation. Keep the blobless history/refspec
# intact and avoid HTTP/2 framing failures. Callers bound this step to 4 minutes.
set -eu

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
