/** Live case we#7448/#7451: a "no code defect" stand-down on a PR whose only red is the stale review:changes hold
 * deadlocked (fixer won't push, rearm refuses an unchanged head, nobody answers). The fixed daemon plans exactly one
 * mechanical rearm-review answer per head. Contract: we:scripts/conveyor/stand-down-no-code-owed.mjs.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStandDownComment } from '../../stand-down.mjs';
import { AUTOMATION_LOGINS } from '../../../lib/marker-authorship.mjs';

const head = 'a'.repeat(40);
const author = { login: AUTOMATION_LOGINS[0] };
const names = ['test', 'merge-gate'];

export default {
  id: 'no-code-owed-stand-down-deadlock',
  title: 'a no-code-defect stand-down gets exactly one re-review answer per head, never when code is owed',
  card: 'STANDDOWN-EMPTY-ROUND (we#7448, we#7451)',
  fixedBy: { sha: 'uncommitted', where: 'stand-down-no-code-owed', paths: ['scripts/conveyor/stand-down-no-code-owed.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/conveyor/stand-down-no-code-owed.mjs')); },
  async run() {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const { classifyNoCodeOwedRearm } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down-no-code-owed.mjs')).href);
    const verdict = { id: 'V', author, body: '🔁 review — changes requested\n\nx' };
    const begin = sha => ({ id: 'B', author, body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\`\n<!-- fix-claim who=f -->` });
    const stand = { id: 'SD1', author, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'no code defect to repair' }) };
    const run = (name, conclusion) => ({ id: name.length, name, app: { id: 15368 }, head_sha: head, status: 'completed', conclusion });
    const base = { requiredChecks: names, requiredCheckBindings: names.map(context => ({ context, integration_id: 15368 })),
      checks: { head, complete: true, runs: [run('test', 'SUCCESS'), run('merge-gate', 'FAILURE')] } };
    const mk = comments => ({ number: 1, headRefOid: head, labels: [{ name: 'review:changes' }], comments });
    const first = classifyNoCodeOwedRearm({ ...base, pr: mk([verdict, begin(head), stand]) });
    const second = first.action === 'rearm-answer'
      ? classifyNoCodeOwedRearm({ ...base, pr: mk([verdict, begin(head), stand, { id: 'A', author, body: first.body }, { ...stand, id: 'SD2' }]) }) : null;
    const owed = classifyNoCodeOwedRearm({ ...base, pr: mk([verdict, begin('b'.repeat(40)), stand]) });
    return { first: first.action, second: second?.action, owed: owed.action };
  },
  judge(r) {
    return [
      ...(r.first === 'rearm-answer' ? [] : [`deadlock: no re-review planned (${r.first})`]),
      ...(r.second === 'hold' ? [] : [`loop: second attempt on the same head was ${r.second}`]),
      ...(r.owed === 'hold' ? [] : ['code owed was re-reviewed mechanically']),
    ];
  },
};
