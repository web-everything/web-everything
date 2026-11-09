/** A finished (status idle) session ending on a dangling tool call must stop holding its PR after the 90-minute grace. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, '../../../../..');
const MIN = 60_000;

/** The behavioural scenario, run against the tree at `root` through the real reconcile wiring
 *  (`makeReconcileIdleFinishedInfoFor` -> `readIdleFinishedInfo`) and the real reaper resolver. */
export async function scenario(root) {
  const dir = mkdtempSync(join(tmpdir(), 'soak-idle-dangling-'));
  const prev = process.env.CLAUDE_PROJECTS_DIR;
  try {
    const cwd = '/soak/dispatch/ci-heal-6589';
    const sessionId = 'soak-sess-6589';
    mkdirSync(join(dir, cwd.replaceAll('/', '-')), { recursive: true });
    process.env.CLAUDE_PROJECTS_DIR = dir;
    const at = (rel) => import(`${pathToFileURL(join(root, rel)).href}?soak=${Date.now()}`);
    const { makeReconcileIdleFinishedInfoFor } = await at('scripts/conveyor/reconcile-pass.mjs');
    const { makeIdleFinishedResolver } = await at('scripts/conveyor/session-reaper.mjs');
    if (typeof makeReconcileIdleFinishedInfoFor !== 'function') return { violations: ['no reconcile-side idle-finished reader exists in this tree'] };
    const now = Date.now();
    const write = (minsAgo) => writeFileSync(join(dir, cwd.replaceAll('/', '-'), `${sessionId}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: new Date(now - minsAgo * MIN).toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node -e "import(x)"' } }] },
    })}\n`);
    const row = { cwd, sessionId, status: 'idle' };
    const reconcile = (freshStatus) => makeReconcileIdleFinishedInfoFor({
      hungThresholdMs: 30 * MIN, exec: () => JSON.stringify([{ sessionId, status: freshStatus }]),
    })(row, now, 10 * MIN);
    const violations = [];
    write(100);
    if (reconcile('idle').finished !== true) violations.push('idle dangling session past the 90-minute grace keeps holding its PR');
    if (reconcile('busy').finished === true) violations.push('session released although the fresh read says busy');
    if (makeIdleFinishedResolver({ thresholdMs: 10 * MIN, now: () => now })(row)?.finished === true) violations.push('reaper path released a dangling-call session');
    write(75);
    if (reconcile('idle').finished === true) violations.push('session released inside the 90-minute grace');
    return { violations };
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

export default {
  id: 'idle-row-dangling-call-holds-pr',
  title: 'an idle-status session with a dangling tool call is released after the 90-minute grace with a fresh read, never earlier or on a busy read',
  card: 'soak-replay-gate',
  fixedBy: { sha: 'pending', where: 'main', paths: [
    'scripts/conveyor/hung-session.mjs', 'scripts/conveyor/reconcile-pass.mjs',
  ] },
  /** Behavioural: runs the scenario against the tree in a child process; the fix is present only when it passes. */
  fixPresent(root) {
    try {
      const code = `import(${JSON.stringify(pathToFileURL(SELF).href)}).then(async (m) => { const r = await m.scenario(${JSON.stringify(root)}); process.exit(r.violations.length ? 1 : 0); }).catch(() => process.exit(2));`;
      execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', timeout: 60_000 });
      return true;
    } catch {
      return false;
    }
  },
  async run() {
    return scenario(process.env.SOAK_TREE_ROOT || ROOT);
  },
  judge(report) { return report.violations; },
};
