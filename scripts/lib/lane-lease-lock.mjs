/**
 * Serialize short lease mutations across heartbeat, allocator and release processes.
 * The lock never expires: a paused writer must not resume after another writer has
 * taken its lock. A crash leaves a fail-closed lock; operators must confirm that
 * no writer remains before removing it and retrying. No automatic stale takeover.
 */
import { mkdirSync, rmdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function laneLeaseLockPath(file) {
  const gitDir = realpathSync(dirname(file));
  // Outside the checkout for ordinary clones: git clean, quarantine and reclone
  // must not remove the mutex while an old writer still holds it.
  const target = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
  return join(dirname(target), `.${basename(target)}.lane-lease-lock`);
}

export function withLaneLeaseMutation(file, run) {
  const lock = laneLeaseLockPath(file);
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(new Error(`lease mutation busy: ${lock}; retry after the writer finishes. If abandoned, confirm no writer remains before removing this lock.`), { code: 'ELEASEBUSY' });
  }
  try { return run(); } finally { rmdirSync(lock); }
}
