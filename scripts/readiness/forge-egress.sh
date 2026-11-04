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
# Rollback (in this order; forge-setup.sh gives ssh.service a drop-in with Requires=forge-exec-egress.service, so remove
# it and reload FIRST, otherwise stopping the egress service can stop sshd):
#   rm -f /etc/systemd/system/ssh.service.d/forge-egress.conf;
#   systemctl daemon-reload;
#   nft delete table inet forge_exec_egress;
#   systemctl disable --now forge-exec-egress.timer forge-exec-egress.service
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
# Only well-formed addresses of the right family ever reach the nft ruleset (history is read back from disk, so it is not
# trusted text; a hex-only word like `dead` must not be left for nft to resolve as a hostname). $1 = 4|6.
OCT='(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'   # 0-255, no leading zeros (never read as octal)
HEX='[0-9A-Fa-f]{1,4}'
RE_V4="^$OCT(\.$OCT){3}\$"
RE_V6_FULL="^$HEX(:$HEX){7}\$"
RE_V6_COMPRESSED="^($HEX(:$HEX){0,6})?::($HEX(:$HEX){0,6})?\$"
valid_v4() { [[ "$1" =~ $RE_V4 ]]; }
valid_v6() { # at least two colons, hex groups of 1-4 digits, at most one `::`, optional dotted-v4 tail
  local a=$1 tail colons parts
  [[ "$a" =~ ^[0-9A-Fa-f:.]+$ ]] || return 1
  tail=${a##*:}
  if [[ "$tail" == *.* ]]; then valid_v4 "$tail" || return 1; a="${a%"$tail"}0:0"; fi   # v4 tail = two groups
  colons=${a//[!:]/}
  (( ${#colons} >= 2 )) || return 1
  if [[ "$a" == *::* ]]; then
    parts=(${a//:/ })                   # written groups (only hex digits/colons remain: no glob characters)
    (( ${#parts[@]} <= 7 )) || return 1 # `::` stands for at least one zero group: at most 7 written groups
    [[ "$a" =~ $RE_V6_COMPRESSED ]]
  else
    [[ "$a" =~ $RE_V6_FULL ]]
  fi
}
addr_only() {
  local a
  { tr ' ' '\n' | { while IFS= read -r a || [[ -n "$a" ]]; do
      if [[ "$1" == 6 ]]; then valid_v6 "$a" && printf '%s\n' "$a"; else valid_v4 "$a" && printf '%s\n' "$a"; fi
    done; } | sort -u; } || true
}
snapshot() { # fix ONE lookup per apply: the table that is installed is the table that gets recorded
  CUR4=$(resolve_registry 4 | addr_only 4); CUR6=$(resolve_registry 6 | addr_only 6); SNAPSHOT_TAKEN=1
}
registry_ips() { # $1 = 4|6 — current lookup plus the retained snapshots
  local cur="CUR$1" hist=''
  # History we cannot maintain (state dir not writable) is not trusted: a failed write must only ever narrow the allowlist.
  [[ -r "$STATE_DIR/registry$1" && -w "$STATE_DIR" ]] && hist=$(addr_only "$1" < "$STATE_DIR/registry$1")
  printf '%s\n%s\n' "${!cur}" "$hist" | addr_only "$1"
}
record_snapshot() { # $1 = 4|6 — append the current non-empty lookup, keep the last KEEP lines (atomic rename)
  local cur="CUR$1" line tmp
  line=$(printf '%s\n' "${!cur}" | addr_only "$1" | tr '\n' ' ')
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
    # Always install the freshly rendered table. A DNS blip yields an EMPTY allowlist (closed) unless a recent
    # snapshot (grace window, see above) still holds addresses; never the stale LIVE table itself: availability of cold installs yields to the no-egress guarantee (they fall back to local).
    nft -f - <<<"$rules"
    # Remember what resolved only after the table loaded. The v4 and v6 records are independent. If one fails, its old
    # state file is removed so the next allowlist holds only the then-current lookup (it can only narrow: closed side).
    for fam in 4 6; do
      record_snapshot "$fam" || {
        rm -f -- "$STATE_DIR/registry$fam" 2>/dev/null || true
        echo "forge-egress: could not record the registry$fam snapshot (history cleared, grace window not extended)" >&2
      }
    done ;;
  *) echo 'usage: forge-egress.sh render|apply' >&2; exit 2 ;;
esac
