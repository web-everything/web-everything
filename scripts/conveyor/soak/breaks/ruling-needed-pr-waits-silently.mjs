/**
 * @file breaks/ruling-needed-pr-waits-silently.mjs — live break 2026-10-04 04:32Z-12:15Z, PR #3794 (also #3771,
 * #3833). The re-review loop correctly PARKED the review ("review paused: N referrals need a ruling") on a PR
 * with CONFIRMED findings awaiting a block/card/not-real ruling — and then nothing told the operator for about 8
 * hours: no needs-you row, no push, no distinct label, no alert. The operator learned of it only by asking.
 *
 * FIX: a derived `advisory:ruling-needed` label, a RULING NEEDED queue row (one line per finding plus file), one
 * push per PR and head, and a `ruling-needed-waiting` health smell (config `rulingNeededAfterMs`, default 2 h).
 *
 * SCENARIO: the live PR shape (a trusted, attempted referral record on the current head, no ruling) is run
 * through every surface. RED = any surface silent: no label planned, no queue row, no push, no health breach at
 * 8 h; or a surface that does not clear on a ruling / a new head (control).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const src = process.env.SOAK_SOURCE_ROOT;
const imp = (rel) => import(pathToFileURL(join(src, rel)).href).catch(() => null);
const jury = await imp('scripts/lib/jury-core.mjs');
const sweep = await imp('scripts/conveyor/ruling-needed-sweep.mjs');
const queue = await imp('scripts/operations/operator-queue.mjs');
const notify = await imp('scripts/operations/operator-notify.mjs');
const smell = (await imp('scripts/conveyor/health-smells/ruling-needed-waiting.mjs'))?.default;
const core = await imp('scripts/conveyor/health-watch-core.mjs');
const repo = 'web-everything/web-everything';
const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40);
const T0 = Date.parse('2026-10-04T04:32:00Z');
const original = { summary: 'policy pointer files are not listed', file: 'policy/pointer.md', line: 3, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const key = jury.referralFindingKey('judge', original);
const reviewer = jury.mandatoryReferralReviewer('run-1');
const rec = (rulings) => ({ version: 1, repo, pr: 3794, head: H1, runId: 'run-1', reviewer, authorBody: '<!-- authored-by-actor: a -->',
  attempted: true, referrals: [{ key, seat: 'judge', original, finding: jury.normalizeFinding(original) }], rulings });
const block = [{ id: 'r0', key, reviewerId: reviewer.id, lens: reviewer.lens, result: 'block', rationale: 'x', evidence: ['e'] }];
const pr = (over = {}, rulings = []) => ({ repo, number: 3794, title: 'policy pointers', headRefOid: H1, labels: [{ name: 'review:human' }],
  comments: [{ body: jury.renderReferralRecord(rec(rulings)), createdAt: new Date(T0).toISOString(), author: { login: 'web-everything' } }], ...over });
const out = { missing: [], label: null, row: false, pushes: 0, pushesAgain: 0, healthAt1h: null, healthAt8h: null, control: {} };
if (!jury || !sweep || !queue?.rulingNeededRow || !notify?.rulingRows || !smell || !core) {
  out.missing.push('ruling surfaces');
} else {
  out.label = sweep.planRulingNeededLabel(pr()).action;
  out.row = !!queue.rulingNeededRow(repo, pr());
  const q = (p) => ({ ready: [], errors: [], rulingNeeded: [queue.rulingNeededRow(repo, p)].filter(Boolean) });
  let saved = { notified: {} };
  const run = async (p) => { let n = 0; await notify.runOperatorNotify({ readQueue: async () => q(p), readState: async () => saved,
    writeState: async (s) => { saved = s; }, notify: async () => { n++; return { ok: true }; }, now: 't' }); return n; };
  out.pushes = await run(pr());
  out.pushesAgain = await run(pr());
  const cfg = { ...core.DEFAULT_HEALTH_CONFIG };
  out.healthAt1h = smell.evaluate({ prs: [pr()] }, { now: T0 + 3600e3, config: cfg })[0]?.breach ?? null;
  out.healthAt8h = smell.evaluate({ prs: [pr()] }, { now: T0 + 8 * 3600e3, config: cfg })[0]?.breach ?? null;
  const labelled = pr({ labels: [{ name: 'review:human' }, { name: 'advisory:ruling-needed' }] });
  out.control.clearsOnRuling = sweep.planRulingNeededLabel({ ...labelled, comments: pr({}, block).comments }).action;
  out.control.clearsOnNewHead = sweep.planRulingNeededLabel({ ...labelled, headRefOid: H2 }).action;
}
process.stdout.write(JSON.stringify(out));
`;

export default {
  id: 'ruling-needed-pr-waits-silently',
  title: 'a PR parked on unanswered mandatory referrals waits for hours with no label, needs-you row, push or health alert',
  card: 'operator order 2026-10-04 ~08:15 ET; live incident PR #3794 04:32Z-12:15Z (also #3771, #3833)',
  fixedBy: { sha: 'b01658095e2513f2b0ca7f5923b08ce0723f851c,9262954bee52086a168380dd4445d3170d1d7e7b,c144900a6da7ebb005f1e5d83adb73f84e16aa27,4a33d462c910fbbd29444b1600ff5b1d717570d7,3aeccaa0bf05f4ae5d2c565866f46b587787da8a', where: 'lane/fix-ruling-needed-surface', paths: [
    'scripts/conveyor/fixer-ladder.mjs',
    'scripts/conveyor/health-responder-core.mjs',
    'scripts/conveyor/health-smells-notify-list.mjs',
    'scripts/conveyor/health-smells/ruling-needed-waiting.mjs',
    'scripts/conveyor/health-watch-core.mjs',
    'scripts/conveyor/health-watch.mjs',
    'scripts/conveyor/reconcile-core.mjs',
    'scripts/conveyor/reconcile-fix-dispatch.mjs',
    'scripts/conveyor/reconcile-note-comment.mjs',
    'scripts/conveyor/reconcile-pass.mjs',
    'scripts/conveyor/review-hold-reconcile.mjs',
    'scripts/conveyor/review-referral-hold.mjs',
    'scripts/conveyor/ruling-needed-sweep.mjs',
    'scripts/lib/dispatch-routing-policy.json',
    'scripts/lib/fixer-escalation-policy.mjs',
    'scripts/lib/ruling-ledger.mjs',
    'scripts/operations/operator-notify.mjs',
    'scripts/operations/operator-queue.mjs',
    'skills-src/conveyor/review-daemon.mjs',
  ] },
  fixPresent(root) { return existsSync(join(root, 'scripts/lib/ruling-ledger.mjs')); },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-ruling-needed-'));
    const violations = [];
    try {
      const childFile = join(dir, 'child.mjs');
      writeFileSync(childFile, CHILD);
      let out;
      try {
        out = JSON.parse(execFileSync('node', [childFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOAK_SOURCE_ROOT: sourceRoot } }));
      } catch (e) {
        violations.push({ invariant: 'scenario-runs', detail: `the scenario child crashed: ${String(e?.stderr || e?.message || e).split('\n').slice(0, 3).join(' | ')}` });
        return { violations };
      }
      log?.(JSON.stringify(out));
      if (out.missing.length) violations.push({ invariant: 'surfaces-exist', detail: 'no ruling-needed label/row/push/health surface exists, so the parked PR waits silently' });
      else {
        if (out.label !== 'add') violations.push({ invariant: 'label', detail: `expected the advisory:ruling-needed label to be added, got ${out.label}` });
        if (!out.row) violations.push({ invariant: 'needs-you-row', detail: 'no RULING NEEDED queue row for the parked PR' });
        if (out.pushes !== 1 || out.pushesAgain !== 0) violations.push({ invariant: 'push-once', detail: `expected exactly one push, then none for the same head; got ${out.pushes} then ${out.pushesAgain}` });
        if (out.healthAt1h !== false || out.healthAt8h !== true) violations.push({ invariant: 'health-alert', detail: `expected no breach at 1 h and a breach at 8 h; got ${out.healthAt1h} / ${out.healthAt8h}` });
        if (out.control.clearsOnRuling !== 'remove' || out.control.clearsOnNewHead !== 'remove') violations.push({ invariant: 'clears', detail: `the label must clear on a ruling and on a new head; got ${JSON.stringify(out.control)}` });
      }
      return { violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
