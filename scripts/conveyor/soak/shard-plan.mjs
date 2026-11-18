/**
 * @file shard-plan.mjs — what one soak shard runs after quarantine exclusions (pure; used by run-shard.mjs).
 * A shard whose assigned files are ALL excluded FAILS: a green shard that ran no assertions is not evidence.
 * More exclusions than the quarantine cap fail closed too.
 */

/** The red-main quarantine cap (QUARANTINE_SAFETY_NET_DEFAULTS.maxTests): more exclusions than this are refused. */
export const MAX_EXCLUDES = 5;

/**
 * @param {{assigned:string[], excluded:Set<string>}} o
 * @returns {{files:string[], skipped:number, exit:(0|1|null), message:(string|null)}} exit null = run `files`.
 */
export function planShard({ assigned, excluded }) {
  if (excluded.size > MAX_EXCLUDES) {
    return { files: [], skipped: 0, exit: 1, message: `${excluded.size} exclusions exceed the quarantine cap ${MAX_EXCLUDES} — refusing` };
  }
  const files = assigned.filter((file) => !excluded.has(file));
  const skipped = assigned.length - files.length;
  if (!assigned.length) return { files, skipped, exit: 0, message: 'no scenario files assigned to this shard — nothing to run' };
  if (!files.length) return { files, skipped, exit: 1, message: 'every assigned file is quarantined — a shard that runs no assertions must not pass green' };
  return { files, skipped, exit: null, message: null };
}
