import test from 'node:test';
import assert from 'node:assert/strict';
import { planAuditOwed, auditOwedLine, readAutoAuditMode, defaultAuditCheck } from '../audit-on-ready.mjs';
import { runAutoAuditShadow } from '../../../skills-src/conveyor/review-daemon.mjs';

const repo = 'example/widgets', head = 'a'.repeat(40);
const labels = ['review:human', 'advisory:accepted', 'red-team:clear'];
const pr = (extra = {}) => ({ number: 17, state: 'OPEN', isDraft: false, headRefOid: head,
  headRefName: 'lane/audit', labels, ...extra });
const owed = (extra = {}) => planAuditOwed({ repo, rawPrs: [pr()], check: () => ({ ok: false }), seen: new Set(), ...extra });
const expected = state => [{ repo, pr: 17, head, state }];

test('review:human + accepted + red-team clear head with no canonical record is owed an audit', () => {
  assert.deepEqual(owed(), expected('owed'));
  assert.deepEqual(owed({ rawPrs: [pr({ labels: labels.map(name => ({ name })) })] }), expected('owed'));
  assert.equal(auditOwedLine(expected('owed')[0]), `audit-owed ${repo}#17 @${head}`);
});
test('canonical check receives the exact head and PR row; ok is not owed', () => {
  const row = pr();
  assert.deepEqual(owed({ rawPrs: [row], check: (sha, input) => {
    assert.equal(sha, head); assert.equal(input, row); return { ok: true };
  } }), []);
});
test('weakened canonical record is not owed', () => {
  assert.deepEqual(owed({ check: () => ({ ok: false, reason: 'canonical-audit-weakened' }) }), []);
});
for (const label of labels) test(`missing ${label} is not owed`, () => {
  assert.deepEqual(owed({ rawPrs: [pr({ labels: labels.filter(value => value !== label) })],
    check: () => assert.fail('ineligible PR must not be checked') }), []);
});
test('draft, closed, and merged PRs are not owed', () => {
  for (const extra of [{ isDraft: true }, { state: 'CLOSED' }, { state: 'MERGED' }]) {
    assert.deepEqual(owed({ rawPrs: [pr(extra)] }), []);
  }
});
test('check throws or reports unknown evidence: owed-unknown', () => {
  assert.deepEqual(owed({ check: () => { throw Error('unreadable'); } }), expected('owed-unknown'));
  assert.deepEqual(owed({ check: () => ({ ok: false, unknown: true }) }), expected('owed-unknown'));
});
test('seen dedupes by repo, PR and head without mutating seen', () => {
  const seen = new Set([`${repo}#17@${head}`]);
  assert.deepEqual(owed({ seen, check: () => assert.fail('seen head must not be checked') }), []);
  assert.deepEqual(owed({ repo: 'other/widgets', seen }), [{ repo: 'other/widgets', pr: 17, head, state: 'owed' }]);
  assert.deepEqual([...seen], [`${repo}#17@${head}`]);
});
test('invalid, short, and newline-suffixed heads are ignored', () => {
  for (const headRefOid of [undefined, 'a'.repeat(39), 'a'.repeat(41), 'z'.repeat(40), `${head}\n`]) {
    assert.deepEqual(owed({ rawPrs: [pr({ headRefOid })] }), []);
  }
});
test('mode parsing uses shadow file default, env override, and invalid -> off', () => {
  const config = { mode: 'shadow', maxPerTick: 1, maxAttemptsPerHead: 2 };
  const read = () => JSON.stringify(config);
  assert.equal(readAutoAuditMode({}, read), 'shadow');
  assert.equal(readAutoAuditMode(), 'shadow');
  for (const mode of ['off', 'shadow', 'on']) {
    assert.equal(readAutoAuditMode({}, () => JSON.stringify({ ...config, mode })), mode);
    assert.equal(readAutoAuditMode({ WE_REVIEW_AUTO_AUDIT_MODE: mode }, read), mode);
  }
  for (const value of ['', 'ON', 'invalid']) assert.equal(readAutoAuditMode({ WE_REVIEW_AUTO_AUDIT_MODE: value }, read), 'off');
  for (const value of ['{', '{}', 'null', JSON.stringify({ ...config, mode: 'bad' }),
    JSON.stringify({ ...config, maxPerTick: 0 }), JSON.stringify({ ...config, maxAttemptsPerHead: 1.5 })]) {
    assert.equal(readAutoAuditMode({}, () => value), 'off');
  }
  assert.equal(readAutoAuditMode({}, () => { throw Error('unreadable'); }), 'off');
});
test('default audit check wraps the canonical gate and marks unreadable evidence unknown', () => {
  // No checkout exists here: the canonical gate refuses before reading records or fetching.
  const result = defaultAuditCheck({ repoDir: new URL('./missing-audit-checkout', import.meta.url).pathname })(head, pr());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'canonical-audit-missing');
});
test('shadow hook logs once across two ticks and calls no writer; on remains shadow', () => {
  for (const mode of ['shadow', 'on']) {
    const seen = new Set(), lines = []; let writes = 0, checks = 0;
    const options = { repo, rawPrs: [pr()], seen, mode, check: () => { checks++; return { ok: false }; },
      log: { error: line => lines.push(line) }, writer: () => { writes++; } };
    runAutoAuditShadow(options); runAutoAuditShadow(options);
    assert.deepEqual(lines, [`audit-owed ${repo}#17 @${head}`]);
    assert.equal(checks, 1); assert.equal(writes, 0);
    runAutoAuditShadow({ ...options, rawPrs: [pr({ headRefOid: 'b'.repeat(40) })] });
    assert.equal(lines.length, 2);
  }
});
test('shadow hook off performs no checks; logging failure never blocks or marks seen', () => {
  const seen = new Set();
  runAutoAuditShadow({ repo, rawPrs: [pr()], mode: 'off', check: () => assert.fail('off'), seen });
  assert.doesNotThrow(() => runAutoAuditShadow({ repo, rawPrs: [pr()], mode: 'shadow', seen,
    check: () => ({ ok: false }), log: { error: () => { throw Error('sink failed'); } } }));
  assert.equal(seen.size, 0);
});

test('real defaultReadPrs row shape (no state field) is still owed; explicit non-OPEN and drafts are not', () => {
  const row = { number: 17, title: 't', headRefName: 'lane/audit', headRefOid: head, baseRefName: 'main',
    labels: labels.map(name => ({ name })), isDraft: false, comments: [], files: [] };
  assert.equal('state' in row, false);
  assert.deepEqual(owed({ rawPrs: [row] }), expected('owed'));
  assert.deepEqual(owed({ rawPrs: [{ ...row, state: 'CLOSED' }] }), []);
  assert.deepEqual(owed({ rawPrs: [{ ...row, isDraft: true }] }), []);
});
