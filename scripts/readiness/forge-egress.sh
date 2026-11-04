#!/bin/bash
# R497 step 3: slot users (forge-exec-1..N) get NO outbound network except loopback and
# TCP 443 to the npm registry (cold `npm ci` runs AS the slot user under the supervisor,
# forge-exec-run.mjs installDependencies -> workCommand). Warm installs are offline.
# Usage: forge-egress.sh render   # print the nftables ruleset (no root needed)
#        forge-egress.sh apply    # load it atomically (root); re-run to refresh registry IPs
# Env: FORGE_EXEC_SLOTS (default 8); FORGE_EGRESS_UIDS / FORGE_EGRESS_REGISTRY_V4/_V6 override lookups (tests).
#      FORGE_EGRESS_STATE_DIR (default /run/forge-egress) and FORGE_EGRESS_KEEP_SNAPSHOTS (default 3): registry addresses stay
#      allowed for that many refreshes after they last resolved.
# Residual (accepted, see the PR): the allowlist matches destination IP + tcp/443 only. The registry shares CDN addresses
# with other sites, so a slot process can reach any host served from those addresses (SNI is not inspected). Real
# containment needs a non-slot installer user or an SNI-aware proxy.
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
resolve_registry() { # $1 = 4|6 — one fresh lookup, as root
  local override="FORGE_EGRESS_REGISTRY_V$1"
  if [[ -n "${!override+x}" ]]; then printf '%s\n' ${!override}; return; fi
  # Bounded: at boot (before network) an absent resolver must not stall the unit; empty result = closed table.
  local t=''; command -v timeout >/dev/null 2>&1 && t='timeout 5'
  $t getent "ahostsv$1" "$REGISTRY_HOST" 2>/dev/null | awk '{print $1}' | sort -u || true
}
# The registry sits on a rotating CDN pool, and the slot user's own lookup can return an address that was not in
# our snapshot. So an address stays allowed for KEEP refreshes after it last resolved (grace window), and a refresh
# that resolves nothing (DNS blip) never ages the history. State lives in /run (tmpfs): cleared at boot, so a
# rebooted Forge still installs CLOSED until the first successful lookup.
STATE_DIR=${FORGE_EGRESS_STATE_DIR:-/run/forge-egress}
KEEP=${FORGE_EGRESS_KEEP_SNAPSHOTS:-3}
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || KEEP=3
# Only address characters ever reach the nft ruleset (history is read back from disk, so it is not trusted text).
addr_only() { { tr ' ' '\n' | grep -E '^[0-9A-Fa-f:.]+$' | sort -u; } || true; }
snapshot() { # fix ONE lookup per apply: the table that is installed is the table that gets recorded
  CUR4=$(resolve_registry 4 | addr_only); CUR6=$(resolve_registry 6 | addr_only); SNAPSHOT_TAKEN=1
}
registry_ips() { # $1 = 4|6 — current lookup plus the retained snapshots
  local cur="CUR$1" hist=''
  [[ -r "$STATE_DIR/registry$1" ]] && hist=$(addr_only < "$STATE_DIR/registry$1")
  printf '%s\n%s\n' "${!cur}" "$hist" | addr_only
}
record_snapshot() { # $1 = 4|6 — append the current non-empty lookup, keep the last KEEP lines (atomic rename)
  local cur="CUR$1" line tmp
  line=$(printf '%s\n' "${!cur}" | addr_only | tr '\n' ' ')
  [[ -n "${line// /}" ]] || return 0
  mkdir -p -m 0700 "$STATE_DIR" || return 1
  tmp=$(mktemp "$STATE_DIR/.registry$1.XXXXXX") || return 1
  { { [[ -r "$STATE_DIR/registry$1" ]] && cat "$STATE_DIR/registry$1"; } || true; printf '%s\n' "$line"; } | tail -n "$KEEP" > "$tmp" \
    && mv -f -- "$tmp" "$STATE_DIR/registry$1" || { rm -f -- "$tmp"; return 1; }
}

render() {
  # Portable (bash 3.2 for local tests): read lines without mapfile.
  local uids=() v4=() v6=() line
  local uid_out
  [[ -n "${SNAPSHOT_TAKEN:-}" ]] || snapshot
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
  # A flow already open to an address the refresh just dropped keeps working (conntrack outlives the table swap).
  echo '    ct state established,related accept'
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
    snapshot   # one lookup: the installed table and the recorded history come from the same snapshot
    rules=$(render)
    # Always install the freshly rendered table. A DNS blip yields an EMPTY allowlist (closed), never a stale or
    # unvalidated live table: availability of cold installs yields to the no-egress guarantee (they fall back to local).
    nft -f - <<<"$rules"
    # Remember what resolved only after the table loaded. A state-write failure only narrows the next allowlist (closed side).
    record_snapshot 4 && record_snapshot 6 || echo 'forge-egress: could not record the registry snapshot (grace window not extended)' >&2 ;;
  *) echo 'usage: forge-egress.sh render|apply' >&2; exit 2 ;;
esac
