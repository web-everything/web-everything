#!/bin/bash
# measure.sh <vitest|bun> <list-file> <label> [runs]  -> appends one TSV row per run to $OUT
# Columns: label runner run load1 cores wall_s user_s sys_s maxrss_mb exit
# Quiet-host rule: the caller checks load; the 1-minute load average is recorded next to every number regardless.
set -u
runner=$1; list=$2; label=$3; runs=${4:-3}
BUN=${BUN:-bun}; OUT=${OUT:-/dev/stdout}; cores=$(sysctl -n hw.ncpu)
for i in $(seq 1 "$runs"); do
  load=$(uptime | sed -E 's/.*load averages?: ([0-9.]+).*/\1/')
  tmp=$(mktemp)
  if [ "$runner" = vitest ]; then
    /usr/bin/time -l node_modules/.bin/vitest run $(cat "$list") > "$tmp.out" 2> "$tmp"
  else
    /usr/bin/time -l $BUN test --parallel=4 --timeout 60000 --preload ./bun-trial/setup.ts $(sed 's|^|bun-trial/|' "$list") > "$tmp.out" 2> "$tmp"
  fi
  rc=$?
  real=$(grep -E "^ +[0-9.]+ real" "$tmp" | awk '{print $1}'); user=$(grep -E " user " "$tmp" | awk '{print $3}'); sys=$(grep -E " sys" "$tmp" | awk '{print $5}')
  # /usr/bin/time -l line: "   12.34 real  10.1 user  2.2 sys"
  read -r real user sys < <(grep -E " real .* user .* sys" "$tmp" | awk '{print $1, $3, $5}')
  rss=$(grep "maximum resident set size" "$tmp" | awk '{printf "%.0f", $1/1048576}')
  tests=$(grep -E "Tests +[0-9]+|^ *[0-9]+ pass" "$tmp.out" | tr -s ' ' | tr '\n' ' ')
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$label" "$runner" "$i" "$load" "$cores" "$real" "$user" "$sys" "$rss" "$rc" "$tests" >> "$OUT"
  rm -f "$tmp" "$tmp.out"
done
