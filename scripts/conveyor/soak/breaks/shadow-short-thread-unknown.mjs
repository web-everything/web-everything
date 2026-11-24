/** Live shadow log flood: a listed thread below the 100-comment cap was logged "unknown: thread". */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const FIX_SHA = '8bca7188291f1bad5b03cad6578b9958a6c5b251';
const HEAD = 'a'.repeat(40);

export default {
  id: 'shadow-short-thread-unknown',
  title: 'the dispatch-eligibility shadow counts a short listed thread as complete and an explicit false as incomplete',
  card: 'plan step SHADOW-FIX-DISPATCH-ELIGIBILITY',
  fixedBy: { sha: FIX_SHA.slice(0, 9), where: 'lane/shadow-fix-dispatch-eligibility', paths: ['scripts/conveyor/dispatch-eligibility-shadow.mjs'] },
  fixPresent(root) {
    // Git ancestry of the fix commit; never the behaviour under test.
    try { execFileSync('git', ['merge-base', '--is-ancestor', FIX_SHA, 'HEAD'], { cwd: root, stdio: 'ignore' }); return true; }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const load = rel => import(pathToFileURL(join(sourceRoot, rel)).href);
    const { runEligibilityShadow } = await load('scripts/conveyor/dispatch-eligibility-shadow.mjs');
    const { renderRedTeamComment } = await load('scripts/operations/review-extra-seats.mjs');
    const { liveResultGateState, redTeamGateMarker } = await load('scripts/lib/red-team-gate.mjs');
    const bot = body => ({ author: { login: 'web-everything', type: 'Bot' }, body });
    const result = bot(renderRedTeamComment({ pr: 6001, rev: HEAD, provider: 'codex', model: 'm',
      recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ summary: 'Break', category: 'edge-case',
        impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 1, confirmedByRecheck: true }] }));
    const resultId = liveResultGateState([result], 6001, HEAD).resultId;
    const gate = bot(`${redTeamGateMarker(6001, HEAD, 'sent-back', resultId)}\ngate`);
    const locals = () => ({ referral: { state: 'none' }, scope: 'present', claim: { claimed: false },
      pause: { paused: false }, sameHead: { spent: false }, rounds: { attempts: 0, cap: 2 } });
    const lines = (count, flag) => {
      const filler = Array.from({ length: count }, () => bot('chatter'));
      const pr = { number: 6001, headRefOid: HEAD, headRefName: 'lane/x', state: 'OPEN', isDraft: false, labels: [],
        comments: [...filler, result, gate], commentsComplete: flag, commits: [], statusCheckRollup: [], mergeStateStatus: 'CLEAN' };
      const out = [], errors = [];
      runEligibilityShadow({ mode: 'shadow', now: () => 0, readLocals: locals, appendLine: l => out.push(JSON.parse(l)),
        onError: e => errors.push(e),
        dispatch: [{ kind: 'fix', prNumber: 6001, why: 'x', nested: { scope: ['scripts/example.mjs'] } }], prs: [pr] });
      return { out, errors };
    };
    const violations = [];
    const unknownThread = r => r.errors.length === 0 && r.out.length === 1
      && r.out[0].gate === 'unknown' && r.out[0].reasons.length === 1 && r.out[0].reasons[0] === 'thread';
    const short = lines(10, undefined);
    if (short.errors.length || short.out.length) violations.push('a 12-comment thread with the flag unset was logged or errored');
    if (!unknownThread(lines(98, undefined))) violations.push('a thread at the cap (100) was not logged unknown: thread');
    if (!unknownThread(lines(10, false))) violations.push('an explicit commentsComplete=false was not logged unknown: thread');
    log?.(`violations=${violations.length}\n`);
    return { violations };
  },
  judge: report => report.violations,
};
