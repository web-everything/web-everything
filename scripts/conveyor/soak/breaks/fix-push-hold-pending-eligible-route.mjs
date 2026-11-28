/** SHIP-WM-278 + FLOW-DMN-080 (re-cited from SHIP-WM-296, the size rule): E1-E5 are launch-only exemptions; staleBase remains separate. Four PRs (#7453, #7491, #7497, #7515) deadlocked because red-team:pending refused every repair push. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DISPATCH = 'scripts/conveyor/reconcile-fix-dispatch.mjs';

const CASES = [
  // [name, repair, live view, expected hold reason or null]
  ['E1 advisory-fix launches through pending', { mode: 'advisory-fix', labels: ['review:human'] },
    { labels: ['review:human', 'advisory:changes', 'red-team:pending'] }, null],
  ['E2 default-base conflict bounce launches through pending', { isConflict: true, labels: ['review:changes'] },
    { labels: ['review:changes', 'red-team:pending'], mergeable: 'CONFLICTING', baseRefName: 'main' }, null],
  ['takeover stays held', { mode: 'takeover', takeover: {}, labels: ['review:human'] },
    { labels: ['review:human', 'advisory:changes', 'red-team:pending'] }, 'red-team:pending'],
  ['E2 with UNKNOWN mergeable stays held', { isConflict: true, labels: ['review:changes'] },
    { labels: ['review:changes', 'red-team:pending'], mergeable: 'UNKNOWN', baseRefName: 'main' }, 'red-team:pending'],
  ['E3 plain send-back launches through pending', { isConflict: false, labels: ['review:changes'] },
    { labels: ['review:changes', 'red-team:pending'], mergeable: 'MERGEABLE', baseRefName: 'main' }, null],
  ['E3 with UNKNOWN mergeable stays held', { isConflict: false, labels: ['review:changes'] },
    { labels: ['review:changes', 'red-team:pending'], mergeable: 'UNKNOWN', baseRefName: 'main' }, 'red-team:pending'],
  ['E3 with joinedInputs stays held', { isConflict: false, labels: ['review:changes'], joinedInputs: [{}] },
    { labels: ['review:changes', 'red-team:pending'], mergeable: 'MERGEABLE', baseRefName: 'main' }, 'red-team:pending'],
  ['red-team:blocked stays held', { mode: 'advisory-fix', labels: ['review:human'] },
    { labels: ['review:human', 'advisory:changes', 'red-team:pending', 'red-team:blocked'] }, 'red-team:pending'],
  ['E4 operator send-back launches through pending', { mode: 'operator-send-back',
    operatorSendBack: { verdictId: 'SB1', body: 'fix A4' }, labels: ['review:changes', 'review:human'] },
    { labels: ['review:changes', 'review:human', 'red-team:pending'], mergeable: 'MERGEABLE', baseRefName: 'main' }, null],
  ['E4 empty body stays held', { mode: 'operator-send-back',
    operatorSendBack: { verdictId: 'SB1', body: '' }, labels: ['review:changes', 'review:human'] },
    { labels: ['review:changes', 'review:human', 'red-team:pending'], mergeable: 'MERGEABLE', baseRefName: 'main' }, 'red-team:pending'],
  ['E4 UNKNOWN mergeability stays held', { mode: 'operator-send-back',
    operatorSendBack: { verdictId: 'SB1', body: 'fix A4' }, labels: ['review:changes', 'review:human'] },
    { labels: ['review:changes', 'review:human', 'red-team:pending'], mergeable: 'UNKNOWN', baseRefName: 'main' }, 'red-team:pending'],
  ['mixed advisory-fix plus operatorSendBack stays held', { mode: 'advisory-fix',
    operatorSendBack: { verdictId: 'SB1', body: 'fix A4' }, labels: ['review:human'] },
    { labels: ['review:human', 'advisory:changes', 'red-team:pending'] }, 'red-team:pending'],
];

/** Hermetic E5 launch matrix, shared with the unit probe. No host evidence. */
export function joinedPendingCases() {
  const H = 'a'.repeat(40);
  const ji = { head: H, ciFailures: ['x'], reviewFindings: ['y'] };
  const repair = { headRefOid: H, labels: ['review:changes'], joinedInputs: ji };
  const view = { headRefOid: H, labels: ['red-team:pending', 'review:changes', 'status:ci-red'],
    mergeable: 'MERGEABLE', baseRefName: 'main' };
  const rows = [];
  const add = (name, r = {}, v = {}, expected = 'red-team:pending') =>
    rows.push([name, { ...repair, ...r }, { ...view, ...v }, expected]);
  add('E5 joined CI and review launches through pending', {}, {}, null);
  for (const [name, value] of [
    ['array', [{}]], ['array with head', Object.assign([{}], { head: H })], ['empty array', []],
    ['null', null], ['false', false], ['zero', 0], ['empty string', ''], ['undefined present', undefined],
    ['string', 'joined'], ['number', 1], ['missing head', {}],
    ['short head', { ...ji, head: 'abc' }], ['uppercase head', { ...ji, head: 'A'.repeat(40) }],
    ['non-string head', { ...ji, head: 1 }], ['ciFailures not array', { ...ji, ciFailures: {} }],
    ['reviewFindings not array', { ...ji, reviewFindings: {} }], ['empty reviewFindings', { ...ji, reviewFindings: [] }],
  ]) add(`E5 contract ${name} stays held`, { joinedInputs: value });
  add('E5 joined head mismatch stays held', { joinedInputs: { ...ji, head: 'b'.repeat(40) } });
  add('E5 moved live head stays held', {}, { headRefOid: 'b'.repeat(40) });
  add('E5 missing live head stays held', {}, { headRefOid: undefined });
  add('E5 null planned head stays held', { headRefOid: null });
  add('E5 missing live review verdict stays held', {}, { labels: ['red-team:pending'] });
  add('E5 missing planned review verdict stays held', { labels: [] });
  for (const label of ['review:accepted', 'red-team:blocked', 'merge-status:conflicting'])
    add(`E5 live ${label} stays held`, {}, { labels: [...view.labels, label] });
  for (const mergeable of ['CONFLICTING', 'UNKNOWN']) add(`E5 ${mergeable} stays held`, {}, { mergeable });
  for (const baseRefName of ['other', undefined]) add(`E5 base ${baseRefName} stays held`, {}, { baseRefName });
  for (const mode of ['takeover', 'stale-base-rebase', 'stacked-rebase', 'scope-bloat-rebase',
    'ruling-not-addressed', 'block-ruled-referral', 'mq-failure-recovery', 'advisory-fix', 'operator-send-back'])
    add(`E5 mode ${mode} stays held`, { mode });
  for (const flag of ['takeover', 'scopeBloat', 'restack', 'rulingNotAddressed', 'mqFailureRecovery', 'operatorSendBack'])
    add(`E5 excluded ${flag} stays held`, { [flag]: {} });
  for (const flag of ['blockRuledReferrals', 'openOperatorSendBacks']) add(`E5 excluded ${flag} stays held`, { [flag]: [{}] });
  add('E5 isConflict stays held', { isConflict: true });
  add('E5 review:pending is unaffected', {}, { labels: [...view.labels, 'review:pending'] }, null);
  add('E5 staleBase retains independent exception', { staleBase: {} }, {}, null);
  for (const label of ['review:human', 'review:held-mechanical']) {
    for (const pendingFirst of [true, false]) {
      const labels = pendingFirst ? [...view.labels, label] : [label, ...view.labels];
      add(`E5 ${label} pendingFirst=${pendingFirst} holds independently`, {}, { labels }, label);
      add(`E5 carried ${label} pendingFirst=${pendingFirst} is independently exempt`,
        { labels: [...repair.labels, label] }, { labels }, null);
    }
  }
  add('E5 blocked first reports blocked', {}, { labels: ['red-team:blocked', ...view.labels] }, 'red-team:blocked');
  add('E5 carried blocked still refuses pending', { labels: [...repair.labels, 'red-team:blocked'] },
    { labels: ['red-team:blocked', ...view.labels] });
  return rows;
}

const PROBE = `
const [file, legacy] = [process.argv[1], JSON.parse(process.argv[2])];
const cases = [...legacy, ...(${joinedPendingCases.toString()})()];
const { readLivePushHold } = await import(file);
const H = 'a'.repeat(40);
const out = cases.map(([name, repair, view]) => {
  const run = () => JSON.stringify({ state: 'OPEN', headRefOid: H, ...view, labels: view.labels.map(n => ({ name: n })) });
  const hold = readLivePushHold({ repo: 'we', pr: 1, repair: { headRefOid: H, ...repair } }, { hermetic: false, run });
  return [name, hold ? hold.reason : null];
});
console.log(JSON.stringify(out));`;

function probe(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE,
    pathToFileURL(join(root, DISPATCH)).href, JSON.stringify(CASES)], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
}

export default {
  id: 'fix-push-hold-pending-eligible-route',
  title: 'red-team:pending blocks merge, not an eligible advisory-fix, conflict-bounce, plain, operator or joined CI-plus-review fix launch',
  card: 'REDTEAM-RECOVERY-V2 (SHIP-WM-278, FLOW-DMN-080)',
  fixedBy: { sha: 'pending', where: 'lane/redteam-request-recovery', paths: [DISPATCH] },
  // Decided by behaviour: the two eligible routes launch through pending.
  fixPresent(root) {
    const out = probe(root);
    // Either route launching marks the fix as present; run() then demands both, so a one-route regression fails loudly.
    return !!out && (out[0]?.[1] === null || out[1]?.[1] === null || out[5]?.[1] === null);
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const out = probe(sourceRoot);
    log?.(JSON.stringify(out));
    if (!out) return { violations: ['probe failed to run'] };
    return { violations: [...CASES, ...joinedPendingCases()].flatMap(([name, , , expected], i) =>
      out[i]?.[1] === expected ? [] : [`${name}: got ${out[i]?.[1]}`]) };
  },
  judge: report => report.violations,
};
