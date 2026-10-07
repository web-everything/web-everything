#!/bin/bash
# Run every ported file in its own bun process (isolated), report pass/fail counts. Usage: runall.sh <list-file>
B=${BUN:-bun}
while read -r f; do
  out=$(perl -e 'alarm 240; exec @ARGV' $B test --timeout 30000 --preload ./bun-trial/setup.ts bun-trial/$f 2>&1)
  echo "$f | $(echo "$out" | grep -E "^ *[0-9]+ (pass|fail)" | tr -s ' ' | tr '\n' ' ') | $(echo "$out" | grep -m1 -E "^error|SyntaxError|Cannot find|TypeError" | cut -c1-140)"
done < "$1"
