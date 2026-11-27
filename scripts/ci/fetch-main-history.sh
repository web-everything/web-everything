#!/bin/sh
# CI calls this before dependency installation. Keep the blobless history/refspec
# intact and avoid HTTP/2 framing failures. Callers bound this step to 4 minutes.
set -eu
# Optional local mirror: verify outside the shallow checkout, then own only new files.
verify_contents() {
  git init --bare -q "$verify_tmp" || return 1
  reason=verify-copy
  cp "$1"/*.pack "$1"/*.idx "$verify_tmp/objects/pack/" || return 1
  reason=verify-pack
  for idx in "$verify_tmp"/objects/pack/*.idx; do
    git --git-dir="$verify_tmp" verify-pack "$idx" >/dev/null || return 1
  done
  reason=not-a-commit
  git --git-dir="$verify_tmp" cat-file -e "$2^{commit}" || return 1
  reason=missing-object
  git --git-dir="$verify_tmp" rev-list --objects --filter=blob:none --missing=error "$2" >/dev/null || return 1
}
verify_mirror() {
  reason=verify-init
  verify_tmp=$(mktemp -d "${TMPDIR:-/tmp}/main-history-verify.XXXXXX") || return 1
  if verify_contents "$1" "$2"; then verified=0; else verified=1; fi
  rm -rf "$verify_tmp" || :
  return "$verified"
}
save_fail() {
  rm -rf "$cache.tmp.d" || :
  echo "ci: main history mirror save failed ($1)" >&2
  exit 1
}
save_mirror() {
  if ! rm -rf "$cache.tmp.d" "$cache.old"; then
    echo 'ci: main history mirror save failed (pre-clean)' >&2; exit 1
  fi
  tip=$(git rev-parse refs/remotes/origin/main) || save_fail rev-parse
  mkdir "$cache.tmp.d" || save_fail mkdir
  git rev-list --objects --filter=blob:none "$tip" > "$cache.tmp.d/objects.list" || save_fail rev-list
  git pack-objects -q "$cache.tmp.d/pack" < "$cache.tmp.d/objects.list" || save_fail pack-objects
  rm "$cache.tmp.d/objects.list" || save_fail pack-objects
  for pack in "$cache.tmp.d"/*.pack; do
    printf '' > "${pack%.pack}.promisor" || save_fail promisor
  done
  printf '%s\n' "$tip" > "$cache.tmp.d/sha" || save_fail sha
  verify_mirror "$cache.tmp.d" "$tip" || save_fail "$reason"
  moved=0
  if [ -e "$cache" ]; then
    mv "$cache" "$cache.old" || save_fail move-old
    moved=1
  fi
  if ! mv "$cache.tmp.d" "$cache"; then
    if [ "$moved" -eq 1 ] && ! mv "$cache.old" "$cache"; then
      echo "ci: main history mirror rollback failed; no mirror at $cache" >&2
    fi
    save_fail publish
  fi
  rm -rf "$cache.old" || echo "ci: warning: could not remove $cache.old; next save removes it" >&2
  exit 0
}
install_mirror() {
  reason=install
  packdir=$(git rev-parse --git-path objects/pack) || return 1
  mkdir -p "$packdir" || return 1
  for file in "$cache"/*.pack "$cache"/*.idx "$cache"/*.promisor; do
    [ -e "$file" ] || continue
    dest="$packdir/${file##*/}"
    if [ -e "$dest" ]; then
      reason=collision
      cmp -s "$file" "$dest" || return 1
    else
      reason=install-list
      printf '%s\n' "$dest" >> "$list" || return 1
      reason=install
      cp "$file" "$dest" || return 1
    fi
  done
  reason=update-ref
  git update-ref refs/remotes/origin/main "$tip" || return 1
}
restore_mirror() {
  if [ ! -d "$cache" ] || [ ! -e "$cache/sha" ]; then
    echo 'ci: no cached main history; doing the full fetch'; return 0
  fi
  reason=bad-sha
  tip=$(cat "$cache/sha") || return 1
  case "$tip" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#tip}" -eq 40 ] || return 1
  verify_mirror "$cache" "$tip" || return 1
  reason=install-list
  list=$(mktemp "${TMPDIR:-/tmp}/main-history-install.XXXXXX") || return 1
  if install_mirror; then
    rm -f "$list" || :
    echo "ci: seeded main history from cache ($tip)"; return 0
  fi
  while IFS= read -r dest; do
    rm -f "$dest" || :
    if [ -e "$dest" ]; then echo "ci: warning: could not remove seeded file $dest" >&2; fi
  done < "$list"
  rm -f "$list" || :
  return 1
}
if [ -n "${MAIN_HISTORY_CACHE_DIR:-}" ]; then
  cache=$MAIN_HISTORY_CACHE_DIR
  if [ "${1:-}" = save ]; then save_mirror; fi
  restore_mirror || echo "ci: cached main history unusable ($reason); doing the full fetch" >&2
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
