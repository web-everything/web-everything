/** Shared lane-pool dependency preparation, also runnable in a pinned lane. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NPM_INSTALL_TIMEOUT_MS } from './bounded-child.mjs';

const DEPS_MARKER = (dir) => join(dir, '.git', '.lane-pool-deps'); // inside .git ⇒ never tracked or git-cleaned
function lockHash(dir) {
  const lock = join(dir, 'package-lock.json');
  const pkg = join(dir, 'package.json');
  const file = existsSync(lock) ? lock : existsSync(pkg) ? pkg : null;
  if (!file) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
export function depsReady(dir) {
  const want = lockHash(dir);
  if (want === null) return 'n/a'; // no package.json → nothing to install
  if (!existsSync(join(dir, 'node_modules'))) return 'missing';
  const have = existsSync(DEPS_MARKER(dir)) ? readFileSync(DEPS_MARKER(dir), 'utf8').trim() : null;
  return have === want ? 'ok' : 'stale';
}
// #3461 — `npm ci`/`npm install` here is a DELIBERATE, NAMED EXCEPTION to the heavy-command admission queue
// (`scripts/readiness/heavy-admission.mjs`), not an oversight. #3456's own ruling is explicit that the cap
// applies at heavy-command-INVOCATION time, never at lane-ACQUIRE time — "a lane may always be acquired
// freely" — and `ensureDeps` runs INSIDE `acquire`/`provision`/`refresh` (see the three call sites below), so
// routing it through the semaphore would violate that guarantee directly: a lane trying to acquire could queue
// behind check:standards/test:unit runs in OTHER lanes, which is exactly the coupling #3456 ruled out. Passing
// `--no-install` at every dispatched-agent acquire call site and gating `npm ci` as its own explicit
// post-acquire step was the alternative #3461 considered and rejected — it would touch every acquire call
// site (including `delivery-agent-brief.md` and every skill/workflow that provisions a lane), for a command
// that is comparatively cheap and already deduped by `depsReady`'s lockfile-hash skip (most acquires do
// nothing here at all). This function stays ungated.
export function ensureDeps(dir, { run = execFileSync, log = m => process.stderr.write(m + '\n') } = {}) {
  const state = depsReady(dir);
  if (state === 'n/a' || state === 'ok') return state;
  const useCi = existsSync(join(dir, 'package-lock.json'));
  log(`  deps ${state} → npm ${useCi ? 'ci' : 'install'} in ${dir} …`);
  // #x5n4zn3 review — npm's stdout goes to OUR stderr (fd 2), never our stdout: `acquire --json` prints its
  // result on stdout, and a caller that captures it (`orphan-claim-release.mjs`'s `acquireLane`) must parse
  // pure JSON even on the acquires that actually install. Stays visible on a terminal either way.
  run('npm', [useCi ? 'ci' : 'install'], { cwd: dir, stdio: ['inherit', 2, 'inherit'], timeout: NPM_INSTALL_TIMEOUT_MS, killSignal: 'SIGKILL' });
  writeFileSync(DEPS_MARKER(dir), lockHash(dir));
  return 'installed';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureDeps(process.cwd());
