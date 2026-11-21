/** The drain must refuse branch numbering BEFORE pushing when its checkout is stale or the new numbers are invalid. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const entry = (path) => `100644 blob ${'a'.repeat(40)}\t${path}\0`;

export function exercise(prepareBranchBeforeEnqueue) {
  const violations = [];
  for (const [label, behind, nnn, expectPush] of [['stale checkout', '38', '041', false], ['taken number', '0', '040', false], ['fresh and valid', '0', '041', true]]) {
    let numbered = false, pushed = false;
    const exec = (_cmd, args) => {
      if (args.includes('--git-path')) return join(mkdtempSync(join(tmpdir(), 'soak-numbering-')), 'sparse-checkout');
      if (args[0] === 'ls-remote') return 'old\trefs/heads/topic\n';
      if (args[0] === 'rev-list') return `${behind}\n`;
      if (args[0] === 'log' && args.includes('--name-only')) return 'scripts/operator.mjs\n';
      if (args[0] === 'ls-files') return numbered ? 'backlog/041-foo.md' : 'backlog/xabc123-foo.md';
      if (args[0] === 'ls-tree') return args.includes('--name-only') ? 'backlog/040-main.md' : entry('backlog/xabc123-foo.md');
      if (args[0] === 'rev-parse') return 'new';
      if (args[0] === 'push') pushed = true;
      return '';
    };
    const fs = { lstatSync: (p) => ({ isSymbolicLink: () => false, isFile: () => p.endsWith('.md'), isDirectory: () => !p.endsWith('.md') }),
      symlinkSync() {}, mkdtempSync: () => '/tmp/fake', rmSync() {}, readFileSync: () => '{"reservations":[]}', mkdirSync() {}, writeFileSync() {}, renameSync() {} };
    const number = () => { numbered = true; return { assigned: [{ hash: 'xabc123', nnn }], committed: true, readSource: 'head' }; };
    const out = prepareBranchBeforeEnqueue({ c: { repo: 'r', num: 4, headRef: 'topic' }, traceHeadSha: 'old', cwd: '/clone', codeRoot: '/clone',
      statePath: '/state/r.json', exec, fs, number, lock: (fn) => ({ ran: true, result: fn() }), isOpen: () => true, log: { write() {} } });
    if (pushed !== expectPush) violations.push(`${label}: push=${pushed}, expected ${expectPush}`);
    if (!expectPush && out.action !== 'skip') violations.push(`${label}: expected skip, got ${out.action}`);
    if (expectPush && out.action !== 'numbered') violations.push(`${label}: expected numbered, got ${out.action}`);
  }
  return { violations };
}

export default {
  id: 'drain-numbering-preflight-before-push',
  title: 'drain refuses branch numbering before push when its checkout is stale or numbers are invalid',
  card: 'drain-no-jit-commit-on-pr-prep (#7249 renumber)',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/lib/queue-branch-numbering.mjs'] },
  fixPresent(root) {
    const probe = `import { exercise } from ${JSON.stringify(import.meta.url)};
      import { prepareBranchBeforeEnqueue } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/queue-branch-numbering.mjs')).href)};
      process.stdout.write(JSON.stringify(exercise(prepareBranchBeforeEnqueue)));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    try { return r.status === 0 && JSON.parse(r.stdout).violations.length === 0; } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { prepareBranchBeforeEnqueue } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/queue-branch-numbering.mjs')).href);
    return exercise(prepareBranchBeforeEnqueue);
  },
  judge: report => report.violations,
};
