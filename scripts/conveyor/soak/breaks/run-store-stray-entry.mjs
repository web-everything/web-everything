/** A run tombstone or stray JSON must never wedge review evidence enumeration. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

// Execute the target checkout's reader: fix presence is observed behavior, never a source-text marker.
export function probe(checkout) {
  const dir = mkdtempSync(join(tmpdir(), 'run-store-stray-'));
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { deepStrictEqual, ok } from 'node:assert';
      const [checkout, dir] = process.argv.slice(1);
      const { readReviewRunEvidence, reviewRunEvidence, decideReferralHold, REFERRAL_RETRY_MS } = await import(pathToFileURL(join(checkout, 'scripts/conveyor/review-referral-hold.mjs')));
      for (const name of ['review-pr-abc.abandoned.json', 'x y.json']) {
        writeFileSync(join(dir, name), '{}');
      }
      const head = 'a'.repeat(40);
      const verdict = { verdict: 'needs-human', pendingReferrals: ['referral-persistence-failed'] };
      const valid = { v: 1, id: 'review-pr-valid', op: 'review-pr', input: { pr: 101 }, cursor: 0,
        findings: { read: { repo: 'test/repo', pr: 101, netBasis: { rev: head } }, referralVerdict: verdict },
        verdict, effects: [], telemetry: [], stepTimings: [
          { step: 'read', stepIndex: 0, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:00:01Z', durationMs: 1000 },
          { step: 'advise', stepIndex: 1, startedAt: '2026-10-01T00:00:01Z', finishedAt: '2026-10-01T00:00:02Z', durationMs: 1000 },
        ], pending: null };
      const completed = { verdict: 'accept', pendingReferrals: [] };
      const misnamed = { ...valid, verdict: completed, id: 'review-pr-bad name', input: { pr: 102 },
        findings: { ...valid.findings, referralVerdict: completed, read: { ...valid.findings.read, pr: 102 } } };
      writeFileSync(join(dir, 'review-pr-valid.json'), JSON.stringify(valid));
      writeFileSync(join(dir, 'review-pr-bad name.json'), JSON.stringify(misnamed));
      const noVerdict = { ...valid, id: 'review-pr-no verdict', verdict: undefined,
        findings: { ...valid.findings, referralVerdict: undefined },
        stepTimings: valid.stepTimings.map(t => ({ ...t,
          startedAt: '2026-10-01T00:01:00Z', finishedAt: '2026-10-01T00:01:01Z' })) };
      writeFileSync(join(dir, 'review-pr-no verdict.json'), JSON.stringify(noVerdict));
      const malformed = { ...misnamed, id: 'review-pr-invalid structure', cursor: -1, effects: {} };
      writeFileSync(join(dir, 'review-pr-invalid structure.json'), JSON.stringify(malformed));
      writeFileSync(join(dir, 'review-pr-unparseable name.json'), '{');
      const expected = [valid, misnamed].map(reviewRunEvidence);
      ok(expected.every(row => row?.pr));
      ok(expected[0].parked && !expected[1].parked && expected[1].completedAt);
      deepStrictEqual(expected.map(row => row.pr), [valid.input.pr, misnamed.input.pr]);
      for (let pass = 0; pass < 2; pass++) {
        const rows = readReviewRunEvidence({ dir, memo: new Map(), persist: false });
        ok(Array.isArray(rows) && rows.length === 3, 'all three records must retain evidence');
        const incomplete = rows.find(row => row.id === noVerdict.id);
        ok(incomplete?.incomplete && incomplete.completedAt === null, 'advise timing without a verdict must remain incomplete');
        const hold = decideReferralHold({ number: 101, headRefOid: head, comments: [],
          labels: [{ name: 'review:human' }] }, rows, { repo: 'test/repo', now: Date.parse('2026-10-01T00:02:00Z') });
        ok(hold?.persistenceFailed && hold.retryAt === Date.parse('2026-10-01T00:00:02Z') + REFERRAL_RETRY_MS[0],
          'a newer misnamed record without a verdict must retain the persistence-failure hold');
        ok(!rows.some(row => row.id === malformed.id), 'structurally invalid misnamed records must not project evidence');
        for (const row of expected) deepStrictEqual(rows.find(r => r.id === row.id), row);
      }
    `, checkout, dir], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WE_UNDER_TEST: '1', WE_DAEMON_EVENTS: join(dir, 'events.jsonl') },
    });
    return { violations: child.status === 0 ? [] : ['review evidence enumeration failed on tombstone/stray entries'] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'run-store-stray-entry',
  title: 'review evidence enumeration tolerates tombstones and stray JSON',
  card: 'run-store invalid-entry enumeration regression',
  fixedBy: { sha: 'HEAD', where: 'main', paths: ['scripts/operations/run-store.mjs', 'scripts/conveyor/review-referral-hold.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
