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
  const scenarios = [
    { label: 'stale checkout', behind: '38', expectPush: false },
    { label: 'taken number', nnn: '040', expectPush: false },
    { label: 'fresh and valid', expectPush: true },
    { label: 'slug rename', listing: 'backlog/040-renamed.md\nbacklog/041-foo.md', expectPush: true },
    { label: 'copy of existing card', listing: 'backlog/040-main.md\nbacklog/040-renamed.md\nbacklog/041-foo.md', expectPush: false },
    { label: 'separate stale code clone', separate: true, codeBehind: '5', expectPush: false },
    { label: 'separate fresh code clone', separate: true, expectPush: true },
    { label: 'code fetch failure', separate: true, fetchFails: true, expectPush: false },
  ];
  for (const { label, behind = '0', nnn = '041', listing = 'backlog/041-foo.md', separate, codeBehind = '0', fetchFails, expectPush } of scenarios) {
    let numbered = false, pushed = false, codeFetched = false;
    const exec = (_cmd, args, options) => {
      if (separate && options.cwd === '/code/scripts/lib') {
        if (args[0] === 'fetch') {
          if (fetchFails) throw new Error('code fetch failed');
          codeFetched = true;
        }
        if (args[0] === 'rev-list') return codeFetched ? codeBehind : '0';
      }
      if (args.includes('--git-path')) return join(mkdtempSync(join(tmpdir(), 'soak-numbering-')), 'sparse-checkout');
      if (args[0] === 'ls-remote') return 'old\trefs/heads/topic\n';
      if (args[0] === 'rev-list') return `${behind}\n`;
      if (args[0] === 'ls-files') return numbered ? listing : 'backlog/xabc123-foo.md';
      if (args[0] === 'ls-tree') return args.includes('--name-only') ? 'backlog/040-main.md' : entry('backlog/xabc123-foo.md');
      if (args[0] === 'rev-parse') return 'new';
      if (args[0] === 'push') pushed = true;
      return '';
    };
    const fs = { lstatSync: (p) => ({ isSymbolicLink: () => false, isFile: () => p.endsWith('.md'), isDirectory: () => !p.endsWith('.md') }),
      symlinkSync() {}, mkdtempSync: () => '/tmp/fake', rmSync() {}, readFileSync: () => '{"reservations":[]}', mkdirSync() {}, writeFileSync() {}, renameSync() {} };
    const number = () => { numbered = true; return { assigned: [{ hash: 'xabc123', nnn }], committed: true, readSource: 'head' }; };
    const out = prepareBranchBeforeEnqueue({ c: { repo: 'r', num: 4, headRef: 'topic' }, traceHeadSha: 'old', cwd: '/clone', codeRoot: separate ? '/code/scripts/lib' : '/clone',
      statePath: '/state/r.json', exec, fs, number, lock: (fn) => ({ ran: true, result: fn() }), isOpen: () => true, log: { write() {} } });
    if (pushed !== expectPush) violations.push(`${label}: push=${pushed}, expected ${expectPush}`);
    if (!expectPush && out.action !== 'skip') violations.push(`${label}: expected skip, got ${out.action}`);
    if (expectPush && out.action !== 'numbered') violations.push(`${label}: expected numbered, got ${out.action}`);
    if (separate && expectPush && !codeFetched) violations.push(`${label}: code clone was never fetched`);
    if (separate && !expectPush && numbered) violations.push(`${label}: numbered before refusing stale or unreadable code`);
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
