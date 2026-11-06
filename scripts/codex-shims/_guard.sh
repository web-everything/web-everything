#!/bin/sh
# Codex heavy-admission guard (R650). Sourced by the vitest/playwright/npx shims.
# Refuses a bare heavy test runner unless heavy-admission holds the slot (WE_HEAVY_ADMISSION_HELD=1).
SHIM_DIR=$(cd "$(dirname "$0")" && pwd -P)
we_real() { # real binary: project node_modules/.bin first, then PATH minus the shim dir
  if [ -x "$PWD/node_modules/.bin/$1" ]; then WE_REAL="$PWD/node_modules/.bin/$1"; return 0; fi
  _old_ifs=$IFS; IFS=:
  for d in $PATH; do
    [ -n "$d" ] && [ -d "$d" ] || continue
    [ "$(cd "$d" && pwd -P)" = "$SHIM_DIR" ] && continue  # any alias of the shim dir (trailing slash, symlink)
    [ -x "$d/$1" ] && { WE_REAL="$d/$1"; IFS=$_old_ifs; return 0; }
  done
  IFS=$_old_ifs; return 1
}
we_guard() {
  tool=$1; shift
  [ "$WE_HEAVY_ADMISSION_HELD" = "1" ] && return 0
  for a in "$@"; do
    case "$a" in --version|-v|-V|--help|-h) return 0;; esac
  done
  echo "REFUSED: bare '$tool' is not allowed inside a Codex run (it would bypass the heavy-admission queue)." >&2
  echo "Run it through: node scripts/readiness/heavy-admission.mjs run -- npx $tool $*" >&2
  exit 97
}
