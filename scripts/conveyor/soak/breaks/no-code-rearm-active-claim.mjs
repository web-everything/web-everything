/** No-code rulings must not spend an answer while a repair owns the PR. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planReconcile } from '../../reconcile-core.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildOperatorAnswer, parseNoCodeRearmReceipt } from '../../stand-down-answer-core.mjs';
import { readLiveDrainClaim } from '../../fix-procedure.mjs';
import { fixDispatchResource } from '../../fix-claim-store.mjs';
import { lockDirFor } from '../../../readiness/file-locks.mjs';
import { discoverModuleFiles } from '../../registry-discovery.mjs';
import { runReconcilePromoteDraftDispatch, defaultReadPrLabels, acquireNoCodeRearmLock } from '../../../operations/promote-draft-pr-dispatch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE = join(ROOT, 'scripts/operations/promote-draft-pr-dispatch.mjs');
const HEAD = 'a'.repeat(40);
const DEFAULT_CASES = ['active-fix', 'active-ci-heal', 'concurrent-fix', 'concurrent-ci-heal',
  'completed-fix', 'completed-ci-heal', 'expired-fix', 'expired-ci-heal', 'missing-store',
  'malformed-claim', 'invalid-heartbeat', 'unreadable-claim', 'throwing-claim', 'timed-out-claim',
  'moved-head', 'missing-labels', 'forged-answer', 'missing-thread', 'oversized-thread'];
const comment = (id, body) => ({ id, body, author: { login: 'chalbert' } });

// Invoke the real shared CLI writer in a bounded native child. Its only forge is this file-backed provider.
function writer(temp, stateFile, args) {
  const childFile = join(temp, 'writer.mjs');
  writeFileSync(childFile, `
import { readFileSync, writeFileSync } from 'node:fs';
import { runReviewLabelCli } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/review-set-label.mjs')).href)};
import { buildRearmComment } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/conveyor/rearm-review.mjs')).href)};
const stateFile = process.argv[2];
const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const save = s => writeFileSync(stateFile, JSON.stringify(s));
runReviewLabelCli({ argv: process.argv.slice(3), fixedTo: 'rearm', defaultActor: 'conveyor', usage: 'fixture',
  buildComment: buildRearmComment,
  successResult: ({ pr, labels }) => ({ ok: true, pr, labels }),
  refusalResult: ({ decision }) => ({ ok: false, reason: decision.reason }),
  rearmRetrySleep: () => {},
  provider: {
    readPrState: () => ({ ...read(), state: 'OPEN', headRefName: 'lane/test', baseRefName: 'main' }),
    readComments: () => read().comments,
    readLabels: () => read().labels,
    setLabels: (_repo, _pr, { add, remove }) => { const s = read(); s.labels = [...new Set([...s.labels.filter(l => !remove.includes(l)), ...(add ? [add] : [])])]; s.labelWrites++; save(s); },
    postComment: (_repo, _pr, body) => { const s = read(); s.comments.push({ id: 'writer-comment', body, author: { login: 'chalbert' } }); s.commentWrites++; save(s); },
  },
});
`);
  return spawnSync(process.execPath, [childFile, stateFile, String(args.prNumber),
    '--repo=no-code-rearm-fixture/example', `--expect-head=${args.expectHead}`, '--actor=conveyor'],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: temp } });
}

function runCase(name, dispatch) {
  const temp = mkdtempSync(join(tmpdir(), 'no-code-claim-'));
  try {
    const store = join(temp, 'claims'), stateFile = join(temp, 'state.json');
    if (name !== 'missing-store') mkdirSync(store);
    const kind = name.endsWith('ci-heal') ? 'ci-heal' : 'fix';
    const claimDir = lockDirFor(store, fixDispatchResource({ repo: 'we', pr: 42, kind }));
    const putClaim = () => {
      mkdirSync(claimDir, { recursive: true });
      writeFileSync(join(claimDir, 'lock.json'), JSON.stringify({ owner: 'fixture-repair',
        heartbeatAt: new Date(name.startsWith('expired') ? Date.now() - 3600000 : Date.now()).toISOString(),
        meta: { repo: 'we', pr: 42, kind } }));
    };
    if (name.startsWith('active') || name.startsWith('expired') || name.startsWith('completed')) putClaim();
    if (name.startsWith('completed')) rmSync(claimDir, { recursive: true });
    if (['malformed-claim', 'invalid-heartbeat', 'unreadable-claim'].includes(name)) {
      putClaim();
      if (name === 'malformed-claim') writeFileSync(join(claimDir, 'lock.json'), '{');
      if (name === 'invalid-heartbeat') writeFileSync(join(claimDir, 'lock.json'), JSON.stringify({ owner: 'repair', heartbeatAt: 'invalid' }));
      if (name === 'unreadable-claim') { rmSync(join(claimDir, 'lock.json')); mkdirSync(join(claimDir, 'lock.json')); }
    }
    const comments = [comment('verdict', `🔁 review — changes requested\n\nFix defect\n<!-- reviewed-sha: ${HEAD} -->`),
      comment('begin', `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD}\``),
      comment('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head: HEAD })),
      comment('answer', buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', reason: 'No code owed',
        channel: 'chat', disposition: 'rearm-review', noCodeOwed: true }))];
    const initial = { headRefOid: HEAD, labels: ['review:changes'], comments, labelWrites: 0, commentWrites: 0 };
    writeFileSync(stateFile, JSON.stringify(initial));
    const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
    const snapshot = () => { const s = read(); return { labels: s.labels, comments: s.comments }; };
    const before = snapshot();
    const plan = planReconcile({ agents: [], requiredChecks: ['gate'], prs: [{ number: 42, state: 'OPEN',
      headRefName: 'lane/test', ...initial, mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] }] });
    let claimReads = 0, lockReleased = false, receipts = 0, launches = 0, writerResult;
    // Mutate evidence after the snapshot, before the executor obtains its fresh evidence.
    const fresh = read();
    if (name === 'moved-head') fresh.headRefOid = 'b'.repeat(40);
    if (name === 'missing-labels') delete fresh.labels;
    if (name === 'forged-answer') fresh.comments.at(-1).author.login = 'untrusted-poster';
    if (name === 'oversized-thread') fresh.comments.push(...Array.from({ length: 1997 }, (_, i) => comment(`extra-${i}`, 'extra')));
    writeFileSync(stateFile, JSON.stringify(fresh));
    const unchanged = snapshot();
    const options = { root: ROOT, checkStaleness: () => ({ fresh: true }),
      provider: { ready() { throw Error('unexpected promotion'); } }, reconcile: () => plan,
      readThread: () => name === 'missing-thread' ? undefined : read().comments,
      readPrLabels: args => defaultReadPrLabels({ ...args, runGh: () => JSON.stringify(read()) }),
      acquireRearmLock: args => {
        const release = acquireNoCodeRearmLock({ ...args, root: temp }, {
          pid: 42, host: 'fixture-host', namespace: 'fixture-namespace',
          stamp: () => ({ runnerStart: 'fixture-start' }),
          identity: () => ({ alive: true }),
        });
        if (name.startsWith('concurrent')) putClaim();
        return () => { release(); lockReleased = true; };
      },
      readClaim: args => {
        claimReads++;
        if (name === 'throwing-claim' || name === 'timed-out-claim') throw Error(name === 'timed-out-claim' ? 'claim read timed out; operator must inspect claim store' : 'claim read failed; operator must inspect claim store');
        return readLiveDrainClaim({ ...args, lockRoot: store });
      },
      postComment: ({ comment: body }) => { const s = read(); s.comments.push(comment(`receipt-${++receipts}`, body)); writeFileSync(stateFile, JSON.stringify(s)); },
      rearm: args => {
        launches++;
        const child = writer(temp, stateFile, args);
        let result;
        try { result = JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch { result = { error: child.stderr }; }
        writerResult = { status: child.status, result };
        return child;
      },
    };
    const result = dispatch(options), after = snapshot();
    if (name.startsWith('completed') || name.startsWith('expired')) dispatch(options);
    const s = read();
    return { name, planned: plan.dispatch.map(d => d.kind), refusals: result.refusals,
      before: name === 'moved-head' || name === 'missing-labels' || name === 'forged-answer' || name === 'oversized-thread' ? unchanged : before,
      after, replayed: snapshot(), claimReads, lockReleased, writerResult,
      effects: { labels: s.labelWrites, comments: s.commentWrites, receipts,
        confirmations: result.dispatched.filter(d => d.kind === 'rearm-no-code').length, launches,
        consumed: s.comments.filter(c => parseNoCodeRearmReceipt(c)?.answerId === 'answer').length } };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

const descriptor = {
  id: 'no-code-rearm-active-claim',
  title: 'no-code rearm retains the ruling while a fix or CI-heal claim is live or unknown',
  card: 'no-code rearm repair-claim exclusion',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/operations/promote-draft-pr-dispatch.mjs', 'scripts/conveyor/stand-down-answer-core.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs'), 'utf8').includes("expectHead ? 'labels,headRefOid'"); },
  run({ cases = DEFAULT_CASES, dispatch = runReconcilePromoteDraftDispatch } = {}) {
    return { cases: cases.map(name => runCase(name, dispatch)) };
  },
  judge(report) {
    return report.cases.flatMap(c => {
      const allowed = c.name.startsWith('completed') || c.name.startsWith('expired');
      const expected = allowed ? 1 : 0;
      const problems = [];
      if (Object.values(c.effects).some(value => value !== expected)) problems.push(`${c.name}: unexpected writes/confirmations ${JSON.stringify(c.effects)}`);
      if (!c.lockReleased) problems.push(`${c.name}: lock was not released`);
      if (!allowed && !c.refusals.length) problems.push(`${c.name}: refusal was not visible`);
      if (allowed && c.writerResult?.result?.ok !== true) problems.push(`${c.name}: real writer failed ${JSON.stringify(c.writerResult)}`);
      return problems;
    });
  },
  async proveGuard() {
    const temp = mkdtempSync(join(tmpdir(), 'no-code-claim-mutant-'));
    try {
      const original = readFileSync(SOURCE, 'utf8');
      let mutant = original.replace('if (claim) {', 'if (false && claim) {');
      if (mutant === original) throw Error('claim guard mutation did not match');
      mutant = mutant.replace(/from (['"])(\.[^'"]+)\1/g, (_all, quote, spec) => `from ${quote}${pathToFileURL(resolve(dirname(SOURCE), spec)).href}${quote}`);
      const path = join(temp, 'dispatch.mjs');
      writeFileSync(path, mutant);
      const { runReconcilePromoteDraftDispatch: dispatch } = await import(pathToFileURL(path).href);
      return { discovered: discoverModuleFiles(dirname(fileURLToPath(import.meta.url))).filter(f => f === `${descriptor.id}.mjs`).map(f => f.slice(0, -4)),
        red: descriptor.run({ cases: ['active-fix'], dispatch }) };
    } finally { rmSync(temp, { recursive: true, force: true }); }
  },
};
export default descriptor;
