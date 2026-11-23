/** A fresh stand-down after a rearm and same-head fixer must remain answerable. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

export function probe(checkout) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { strictEqual } from 'node:assert';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [checkout] = process.argv.slice(1);
    const load = name => import(pathToFileURL(join(checkout, 'scripts/conveyor/' + name + '.mjs')));
    const { rearmWindow } = await load('rearm-review');
    const { buildStandDownComment } = await load('stand-down');
    const { buildOperatorAnswer } = await load('stand-down-answer-core');
    const stamp = (body, id) => ({ body, id, includesCreatedEdit: false,
      author: { login: 'web-everything' } });
    const head = 'a'.repeat(40);
    const begin = id => stamp('🔒 conveyor fix-begin — fix claim held\\n\\n**Branch:** ' +
      String.fromCharCode(96) + 'lane/x' + String.fromCharCode(96) + ' at ' +
      String.fromCharCode(96) + head + String.fromCharCode(96) +
      '\\n<!-- fix-claim who=fix-soak -->', id);
    const stop = id => stamp(buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?' }), id);
    const comments = [stamp('🔁 review — changes requested', 'verdict'), begin('begin-1'), stop('old'),
      stamp(buildOperatorAnswer({ standDownId: 'old', disposition: 'rearm-review',
        reason: 'No code owed', actor: 'chalbert', channel: 'chat' }), 'answer'),
      begin('begin-2'), stop('newest')];
    const win = rearmWindow(comments);
    strictEqual(win.rearmed, false, 'new stand-down must reopen the rearm window');
    strictEqual(win.standDownId, 'newest', 'window must target the newest stand-down');
  `, checkout], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  return { violations: child.status === 0 ? [] : [
    `stand-down after rearm replay failed: ${child.error?.message ?? child.stderr ?? child.signal ?? child.status}`,
  ] };
}

export default {
  id: 'standdown-answer-after-rearm',
  title: 'new stand-down after rearm remains answerable at the same head',
  card: 'stand-down answer after rearm',
  fixedBy: { sha: 'pending', where: 'HEAD', paths: ['scripts/conveyor/rearm-review.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
