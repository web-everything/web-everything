/**
 * @file breaks/queue-split-across-checkouts.mjs — decouple-primary-checkout (epic #4075). The build queue lived in
 * `.conveyor/queue.json` under whichever checkout the queue module was loaded from. The operator clears work from
 * their own primary checkout; the build-dispatch daemon runs from its own dedicated clone. Unless someone pinned
 * `CONVEYOR_STATE_ROOT` at the primary checkout (which then made the automation depend on the operator's working
 * copy), the daemon read a DIFFERENT, empty queue and dispatched nothing — silently.
 *
 * Fix: the queue's default location is the automation's state home (`automation-home.mjs#automationStateRoot`,
 * `<WE_DAEMON_STATE_DIR>/conveyor-state`), outside every checkout, so every process agrees without any pin.
 *
 * Scenario: two "checkouts" in one throwaway workspace — `webeverything` (the operator's) and `wev-control` (the
 * daemon's) — each holding its own copy of the queue module files from the tree under test. Two REAL separate
 * processes, no `CONVEYOR_*` env: process A clears #4242 from the operator's checkout; process B reads the queue
 * from the daemon's clone. B must see #4242, and nothing may be written inside either checkout.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const FIXTURE = fileURLToPath(new URL('./fixtures/queue-op.mjs', import.meta.url));

/** The queue module's own import closure (files missing from an older tree are simply not copied). */
const MODULE_FILES = [
  'scripts/conveyor/queue-store.mjs',
  'scripts/lib/automation-home.mjs',
  'scripts/lib/daemon-clone-layout.mjs', // card 89 S1 — logical clone identity, imported by automation-home + daemon-last-good
  'scripts/lib/daemon-last-good.mjs',
  'scripts/lib/constellation-repos.mjs',
];

function makeCheckout(sourceRoot, dir) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const f of MODULE_FILES) {
    const src = join(sourceRoot, f);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(src, join(dir, f));
  }
}

export default {
  id: 'queue-split-across-checkouts',
  title: 'work cleared from the operator\'s checkout is invisible to a daemon running from its own clone (the queue lived inside each checkout)',
  card: 'we:backlog/4288 (decouple-primary-checkout, epic #4075)',
  fixedBy: { sha: '1ae879a7e', where: 'lane/decouple-primary-checkout', paths: ['scripts/conveyor/queue-store.mjs', 'scripts/lib/automation-home.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/queue-store.mjs');
    return existsSync(p) && /automationStateRoot/.test(readFileSync(p, 'utf8'));
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-queue-split-'));
    const ws = join(dir, 'workspace');
    const operator = join(ws, 'webeverything');
    const daemon = join(ws, 'wev-control');
    const violations = [];
    try {
      makeCheckout(sourceRoot, operator);
      makeCheckout(sourceRoot, daemon);
      const env = { PATH: process.env.PATH, HOME: join(dir, 'home'), WE_DAEMON_STATE_DIR: join(dir, 'state') };
      const op = (root, ...args) => execFileSync(process.execPath, [FIXTURE, root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      let wrote = '';
      let seen = [];
      try {
        wrote = op(operator, 'add', '4242');
        seen = JSON.parse(op(daemon, 'read'));
      } catch (e) {
        violations.push({ invariant: 'crash', detail: String(e?.stderr || e?.message || e).split('\n')[0] });
      }
      log?.(`wrote ${wrote}; daemon sees ${JSON.stringify(seen)}`);
      if (!seen.includes('4242')) violations.push({ invariant: 'daemon-sees-cleared-work', detail: `the daemon's clone read ${JSON.stringify(seen)}; the operator cleared #4242 into ${wrote}` });
      for (const c of [operator, daemon]) {
        if (existsSync(join(c, '.conveyor', 'queue.json'))) violations.push({ invariant: 'no-state-in-a-checkout', detail: `${c}/.conveyor/queue.json was written` });
      }
      return { violations, wrote, seen };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
