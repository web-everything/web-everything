// Gate-only Vitest options the Mac verify gate appends after its test files (`--passWithNoTests` and the
// load-scaled `--testTimeout=`/`--hookTimeout=`). Forge's fixed wrapper does not accept them, so a remote
// run drops them. Dropping can only make that run harder to pass: vitest's own default timeouts (the
// floors below) are never longer, and with no matching test the run fails instead of passing. A remote
// green therefore implies a green with the options; a remote red is confirmed locally with the original
// command by verify-lane (`shouldConfirmRemoteRed`). Only the trailing block is recognized, each option
// at most once, in its exact `=` spelling. Anything else is left in place, and Forge's allowlist then
// keeps the run local.
export const GATE_TIMEOUT_FLOORS = Object.freeze({ '--testTimeout': 5_000, '--hookTimeout': 10_000 });

/** @returns {string[]|null} args without the trailing gate-only options; null when one repeats. */
export function stripGateOnlyOptions(args) {
  const seen = new Set();
  let end = args.length;
  while (end > 0) {
    const arg = args[end - 1];
    let key = null;
    if (arg === '--passWithNoTests') key = arg;
    else {
      const match = /^(--testTimeout|--hookTimeout)=([1-9]\d{0,8})$/.exec(arg);
      if (match && Number(match[2]) >= GATE_TIMEOUT_FLOORS[match[1]]) key = match[1];
    }
    if (!key) break;
    if (seen.has(key)) return null;
    seen.add(key);
    end--;
  }
  return args.slice(0, end);
}
