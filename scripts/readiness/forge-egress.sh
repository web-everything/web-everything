#!/bin/bash
# R497 step 3: slot users (forge-exec-1..N) get NO outbound network except loopback and
# TCP 443 to the npm registry (cold `npm ci` runs AS the slot user under the supervisor,
# forge-exec-run.mjs installDependencies -> workCommand). Warm installs are offline.
# Usage: forge-egress.sh render   # print the nftables ruleset (no root needed)
#        forge-egress.sh apply    # load it atomically (root); re-run to refresh registry IPs
# Env: FORGE_EXEC_SLOTS (default 8); FORGE_EGRESS_UIDS / FORGE_EGRESS_REGISTRY_V4/_V6 override lookups (tests).
# Rollback: nft delete table inet forge_exec_egress; systemctl disable --now forge-exec-egress.timer
set -euo pipefail

SLOTS=${FORGE_EXEC_SLOTS:-8}
REGISTRY_HOST=registry.npmjs.org
TABLE=forge_exec_egress

join_commas() { local out='' x; for x in "$@"; do out+="${out:+, }$x"; done; printf '%s' "$out"; }

slot_uids() {
  if [[ -n "${FORGE_EGRESS_UIDS+x}" ]]; then printf '%s\n' $FORGE_EGRESS_UIDS; return; fi
  local k uid
  for ((k=1; k<=SLOTS; k++)); do
    uid=$(id -u "${FORGE_EGRESS_USER_PREFIX:-forge-exec-}$k") || { echo "forge-egress: cannot resolve slot user $k" >&2; return 1; }
    printf '%s\n' "$uid"
  done
}
registry_ips() { # $1 = 4|6
  local override="FORGE_EGRESS_REGISTRY_V$1"
  if [[ -n "${!override+x}" ]]; then printf '%s\n' ${!override}; return; fi
  # Bounded: at boot (before network) an absent resolver must not stall the unit; empty result = closed table.
  local t=''; command -v timeout >/dev/null 2>&1 && t='timeout 5'
  $t getent "ahostsv$1" "$REGISTRY_HOST" 2>/dev/null | awk '{print $1}' | sort -u || true
}

render() {
  # Portable (bash 3.2 for local tests): read lines without mapfile.
  local uids=() v4=() v6=() line
  local uid_out
  uid_out=$(slot_uids) || return 1   # a failed lookup must abort, never yield a partial uid set
  while IFS= read -r line; do [[ -n "$line" ]] && uids+=("$line"); done <<<"$uid_out"
  (( ${#uids[@]} > 0 )) || { echo 'forge-egress: no slot uids' >&2; return 1; }
  while IFS= read -r line; do [[ -n "$line" ]] && v4+=("$line"); done < <(registry_ips 4)
  while IFS= read -r line; do [[ -n "$line" ]] && v6+=("$line"); done < <(registry_ips 6)
  # One transaction: create-if-missing, drop, recreate. Fail closed when the registry did not resolve.
  echo "add table inet $TABLE"
  echo "delete table inet $TABLE"
  echo "table inet $TABLE {"
  echo "  set registry4 { type ipv4_addr;$([[ ${#v4[@]} -gt 0 ]] && echo " elements = { $(join_commas "${v4[@]}") };") }"
  echo "  set registry6 { type ipv6_addr;$([[ ${#v6[@]} -gt 0 ]] && echo " elements = { $(join_commas "${v6[@]}") };") }"
  echo "  chain slot_egress {"
  echo '    oifname "lo" accept'
  echo '    ip daddr @registry4 tcp dport 443 accept'
  echo '    ip6 daddr @registry6 tcp dport 443 accept'
  echo '    reject with icmpx type admin-prohibited'
  echo '  }'
  echo '  chain output {'
  echo '    type filter hook output priority 0; policy accept;'
  echo "    meta skuid { $(join_commas "${uids[@]}") } jump slot_egress"
  echo '  }'
  echo '}'
}

case "${1:-}" in
  render) render ;;
  apply)
    rules=$(render)
    # Always install the freshly rendered table. A DNS blip yields an EMPTY allowlist (closed), never a stale or
    # unvalidated live table: availability of cold installs yields to the no-egress guarantee (they fall back to local).
    nft -f - <<<"$rules" ;;
  *) echo 'usage: forge-egress.sh render|apply' >&2; exit 2 ;;
esac
