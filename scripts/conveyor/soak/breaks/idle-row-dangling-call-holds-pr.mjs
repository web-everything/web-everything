/** A finished (status idle) session ending on a dangling tool call must stop holding its PR after the 90-minute grace. */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const MIN = 60_000;

export default {
  id: 'idle-row-dangling-call-holds-pr',
  title: 'an idle-status session with a dangling tool call is released after the 90-minute grace with a fresh read, never earlier or on a busy read',
  card: 'soak-replay-gate',
  fixedBy: { sha: 'pending', where: 'main', paths: [
    'scripts/conveyor/hung-session.mjs', 'scripts/conveyor/reconcile-pass.mjs',
  ] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/conveyor/hung-session.mjs'), 'utf8').includes('idle-row-dangling-tool-call')
        && readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('freshAgentStatus');
    } catch {
      return false;
    }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const dir = mkdtempSync(join(tmpdir(), 'soak-idle-dangling-'));
    const prev = process.env.CLAUDE_PROJECTS_DIR;
    try {
      const cwd = '/soak/dispatch/ci-heal-6589';
      const sessionId = 'soak-sess-6589';
      mkdirSync(join(dir, cwd.replaceAll('/', '-')), { recursive: true });
      process.env.CLAUDE_PROJECTS_DIR = dir;
      const { readIdleFinishedInfo } = await import(`${pathToFileURL(join(root, 'scripts/conveyor/hung-session.mjs')).href}?soak=${Date.now()}`);
      const now = Date.now();
      const write = (minsAgo) => writeFileSync(join(dir, cwd.replaceAll('/', '-'), `${sessionId}.jsonl`), `${JSON.stringify({
        type: 'assistant', timestamp: new Date(now - minsAgo * MIN).toISOString(),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node -e "import(x)"' } }] },
      })}\n`);
      const row = { cwd, sessionId, status: 'idle' };
      const opts = (status) => ({ trustIdleRow: true, pendingGraceMs: 90 * MIN, freshStatusFor: () => status });
      const violations = [];
      write(100);
      if (readIdleFinishedInfo(row, now, 10 * MIN, opts('idle')).finished !== true) violations.push('idle dangling session past the 90-minute grace keeps holding its PR');
      if (readIdleFinishedInfo(row, now, 10 * MIN, opts('busy')).finished === true) violations.push('session released although the fresh read says busy');
      if (readIdleFinishedInfo(row, now, 10 * MIN).finished === true) violations.push('reaper path (no opt-in) released a dangling-call session');
      write(75);
      if (readIdleFinishedInfo(row, now, 10 * MIN, opts('idle')).finished === true) violations.push('session released inside the 90-minute grace');
      return { violations };
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
