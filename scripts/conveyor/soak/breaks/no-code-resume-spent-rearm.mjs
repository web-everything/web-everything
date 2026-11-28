/** PR #7567: the production empty-round caller bypassed structured no-code authorization. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as rearm from '../../rearm-review.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildOperatorAnswer, NO_CODE_REARM_RECEIPT } from '../../stand-down-answer-core.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'a'.repeat(40);
const c = (id, body, login = 'web-everything') => ({ id, body, user: { login } });
const claim = id => c(id, `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD}\``);
const thread = () => [c('verdict', `🔁 review — changes requested\n<!-- reviewed-sha: ${HEAD} -->`), claim('initial'),
  c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head: HEAD })),
  c('answer', buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', channel: 'fixture',
    reason: 'No code owed', disposition: 'rearm-review', noCodeOwed: true, head: HEAD }), 'chalbert'), claim('resume')];

/** Execute the actual CLI block and real guards; only external reads, writes and exit are ports. */
export function probeNoCodeRearm({ comments = thread(), snapshot = {}, failSnapshot = false } = {}) {
  const source = readFileSync(resolve(ROOT, 'scripts/conveyor/rearm-review.mjs'), 'utf8');
  const start = source.indexOf('if (IS_CLI) {');
  if (start < 0) throw Error('rearm CLI block missing');
  const result = { handoffs: [], calls: [], output: [], status: 0 };
  const exited = {};
  try {
    runInNewContext(source.slice(start), { ...rearm, IS_CLI: true,
      process: { argv: ['node', 'rearm-review.mjs', '7567', '--repo=fixture/example'],
        exit: status => { result.status = status; throw exited; } },
      resolveChildTimeoutMs: () => 1000,
      readGh: args => {
        result.calls.push(args);
        if (args[0] === 'pr' && args[1] === 'view') {
          if (failSnapshot && args.at(-1).includes('labels')) throw Error('snapshot unavailable');
          return JSON.stringify({ headRefOid: HEAD, labels: [{ name: 'review:changes' }], reviews: [],
            ...(args.at(-1).includes('labels') ? snapshot : {}) });
        }
        if (args[0] === 'api') return JSON.stringify([comments.slice(0, 3), comments.slice(3)]);
        if (args[0] === 'pr' && args[1] === 'comment') return '';
        throw Error(`unexpected read: ${args.join(' ')}`);
      },
      writeLineSync: (_fd, line) => result.output.push(line),
      runReviewLabelCli: options => result.handoffs.push(options.argv),
    }, { timeout: 1000 });
  } catch (error) { if (error !== exited) throw error; }
  return result;
}

export default {
  id: 'no-code-resume-spent-rearm',
  title: 'production rearm refuses consumed no-code rulings and unreadable live holds (PR #7567)',
  card: 'PR #7567',
  fixedBy: { sha: 'HEAD', where: 'lane/fixer-nocode-trailer', paths: ['scripts/conveyor/rearm-review.mjs'] },
  fixPresent(root) {
    return readFileSync(resolve(root, 'scripts/conveyor/rearm-review.mjs'), 'utf8').includes('noCodeOwedAuthorization({ comments, liveHead,');
  },
  async run() {
    const violations = [];
    const receipt = c('receipt', NO_CODE_REARM_RECEIPT('answer', HEAD));
    const cases = [
      ['first resume', {}, true],
      ['spent receipt', { comments: [...thread(), receipt] }, false],
      ['completed rearm', { comments: [...thread(), c('rearmed', rearm.REARM_COMMENT_MARKER)] }, false],
      ['no-change receipt', { comments: [...thread(), c('unchanged', rearm.NO_CHANGE_COMMENT_MARKER)] }, false],
      ['untrusted receipt', { comments: [...thread(), { ...receipt, user: { login: 'outsider' } }] }, true],
      ['formal changes requested', { snapshot: { reviews: [{ state: 'CHANGES_REQUESTED' }] } }, false],
      ['red-team hold', { snapshot: { labels: [{ name: 'review:changes' }, { name: 'red-team:blocked' }] } }, false],
      ['red-team pending', { snapshot: { labels: [{ name: 'review:changes' }, { name: 'red-team:pending' }] } }, false],
      ['missing labels', { snapshot: { labels: null } }, false],
      ['malformed labels', { snapshot: { labels: ['review:changes'] } }, false],
      ['changes label removed', { snapshot: { labels: [{ name: 'review:pending' }] } }, false],
      ['missing reviews', { snapshot: { reviews: null } }, false],
      ['malformed reviews', { snapshot: { reviews: [{}] } }, false],
      ['oversized reviews', { snapshot: { reviews: Array(1001).fill({ state: 'APPROVED' }) } }, false],
      ['live head moved', { snapshot: { headRefOid: 'b'.repeat(40) } }, false],
      ['snapshot read failed', { failSnapshot: true }, false],
    ];
    for (const [name, options, allowed] of cases) {
      const result = probeNoCodeRearm(options);
      if (result.handoffs.length !== (allowed ? 1 : 0) || result.status !== (allowed ? 0 : 1)) {
        violations.push(`${name}: status=${result.status}, label handoffs=${result.handoffs.length}`);
      }
      if (allowed && !result.handoffs[0]?.includes(`--expect-head=${HEAD}`)) violations.push(`${name}: missing head pin`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
