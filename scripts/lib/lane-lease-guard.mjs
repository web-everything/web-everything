import { writeFileSync, rmSync } from 'node:fs';

// Shared by renewal and lane-pool's marker writes/removals. Contention fails closed:
// retry the operation; after a crash, remove a leftover guard only once its writer is stopped.
export function withLaneLeaseGuard(file, work, fs = { writeFileSync, rmSync }) {
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  try { return work(); }
  finally { fs.rmSync(lock, { force: true }); }
}
