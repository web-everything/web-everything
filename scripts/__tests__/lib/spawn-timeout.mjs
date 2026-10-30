import os from 'node:os';

/** Give real CLI fixtures time to finish on a loaded host. */
export function spawnTimeoutMs(baseMs = 30_000) {
  if (process.env.SPAWN_TIMEOUT_MS_OVERRIDE !== undefined) {
    const override = Number(process.env.SPAWN_TIMEOUT_MS_OVERRIDE);
    if (!Number.isSafeInteger(override) || override <= 0) {
      throw new Error('SPAWN_TIMEOUT_MS_OVERRIDE must be a positive integer in milliseconds');
    }
    return override;
  }
  const scale = Math.min(6, Math.max(1, os.loadavg()[0] / os.cpus().length * 2));
  return Math.ceil(baseMs * scale);
}
