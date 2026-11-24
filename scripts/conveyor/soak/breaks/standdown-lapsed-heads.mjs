import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const BREAK_PATH = 'scripts/conveyor/soak/breaks/standdown-lapsed-heads.mjs';
const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
// Before the human commits this fix, behaviour alone decides; afterwards require its ancestry too.
const lineage = git(ROOT, ['log', '-1', '--format=%H', '--diff-filter=A', '--', BREAK_PATH]);
const fix = lineage.stdout?.trim();
export async function exercise(root) {
  const { runStandDownAnswer } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down-answer.mjs')).href);
  const { rearmWindow } = await import(pathToFileURL(join(root, 'scripts/conveyor/rearm-review.mjs')).href);
  const { buildStandDownComment } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down.mjs')).href);
  const trusted = (body, id) => ({ body, id, author: { login: 'web-everything' } });
  const begin = trusted('🔒 conveyor fix-begin — fix claim held\n\n**Branch:** `lane/x` at `aaaaaaaaa`\n<!-- fix-claim who=fix-1 -->', 'IC_begin');
  const comments = [begin, trusted(buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?' }), 'IC_stop'),
    trusted('🔁 review — changes requested', 'IC_verdict'), begin];
  const gh = a => {
    if (a[1] === 'view') return JSON.stringify({ comments, headRefOid: 'b'.repeat(40) });
    comments.push(trusted(a.at(-1), 'IC_answer')); return 'posted';
  };
  try {
    runStandDownAnswer(['7281', '--repo=web-everything/web-everything', '--reason=Review the current head', '--actor=chalbert', '--channel=Codex chat', '--disposition=rearm-review'], { gh });
    return { violations: rearmWindow(comments).rearmed ? [] : ['guard ignored the posted answer'] };
  } catch (e) { return { violations: [e.message] }; }
}
export default {
  id: 'standdown-lapsed-heads', title: 'the latest unresolved lapsed stand-down remains answerable', card: 'STANDDOWN-LAPSED-HEADS / #7281',
  fixedBy: { sha: fix || 'uncommitted', where: 'main', paths: ['scripts/conveyor/stand-down-answer.mjs', 'scripts/conveyor/rearm-review.mjs'] },
  fixPresent(root) {
    if (lineage.status !== 0) return false;
    if (fix && git(root, ['merge-base', '--is-ancestor', fix, 'HEAD']).status !== 0) return false;
    const probe = `import { exercise } from ${JSON.stringify(import.meta.url)}; console.log(JSON.stringify(await exercise(${JSON.stringify(root)})));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    try { return r.status === 0 && JSON.parse(r.stdout).violations.length === 0; } catch { return false; }
  },
  run: ({ sourceRoot = ROOT } = {}) => exercise(sourceRoot), judge: report => report.violations,
};
