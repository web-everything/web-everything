import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameContentRepo } from './fixtures/same-content-repo.mjs';
import { classifyHeadMove, normalizeFinding, findingsSubset, resolveSameDiffCarry } from '../same-content-carry.mjs';
import { createSameContentProof, recordWaiverCarry } from '../same-content-waiver-io.mjs';
import { netDiffFingerprint } from '../net-diff-fingerprint.mjs';
import { readyEvidence, canonicalAuditEvidence } from '../../operations/prototype-load.mjs';
import { QUESTION_HASH } from '../../operations/codex-audit.mjs';
import { decideAcceptCarryForward, isKnownMachineBody } from '../accept-carry-forward.mjs';
import { contributionPatchId, decideRebaseVerdictCarry } from '../rebase-verdict-carry.mjs';
import { buildVerdictCarriedMarker, parseVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';

function fixture(t, kind) { const f = sameContentRepo(kind); t.after(f.cleanup); return f; }
const classify = (f, extra = {}) => classifyHeadMove({ ...f, ...extra });
for (const [kind, allowed, expected] of [
  ['clean', false, 'clean-main-merge'], ['conflict-test', true, 'test-only-merge'],
  ['jit', false, 'jit-rename'], ['test', true, 'test-only'],
]) test(`${kind} carries as ${expected}`, t => {
  const f = fixture(t, kind), result = classify(f, { allowTestOnly: allowed });
  assert.equal(result.carries, true, result.reason); assert.deepEqual(result.commits, [{ sha: f.to, kind: expected }]);
  if (kind === 'clean') assert.notEqual(netDiffFingerprint(f.repo, 'origin/main', f.from), netDiffFingerprint(f.repo, 'origin/main', f.to));
});
for (const kind of ['conflict-code', 'jit-edit', 'outside', 'code', 'octopus', 'mode'])
  test(`${kind} refuses even for a waiver`, t => { assert.equal(classify(fixture(t, kind), { allowTestOnly: true }).carries, false); });
for (const kind of ['conflict-test', 'test']) test(`${kind} refuses without test allowance`, t => {
  assert.equal(classify(fixture(t, kind)).carries, false);
});
test('non-ancestor, unknown refs, option refs, git error and empty range refuse', t => {
  const f = fixture(t, 'clean');
  assert.equal(classify(f, { from: f.to, to: f.from }).carries, false);
  assert.equal(classify(f, { from: 'unknown' }).carries, false);
  assert.equal(classify(f, { from: '--help' }).carries, false);
  assert.equal(classify(f, { exec() { throw Error('git unavailable'); } }).carries, false);
  assert.equal(classify(f, { from: f.root, to: 'origin/main' }).carries, false);
});
test('setting off refuses new paths and reports provenance', t => {
  const f = fixture(t, 'clean'); assert.equal(classify(f, { env: { ...f.env, WE_SAME_DIFF_CARRY: 'off' } }).carries, false);
  assert.equal(resolveSameDiffCarry({ env: { WE_SAME_DIFF_CARRY: 'off' }, platform: 'on', readFile: () => '{"sameDiffCarry":"on"}' }).value, 'off');
  assert.equal(resolveSameDiffCarry({ env: {}, platform: 'on', readFile: () => '{"sameDiffCarry":"off"}' }).source[''], 'tool');
});
test('history bound refuses with an operator fallback', t => {
  const f = fixture(t, 'jit');
  const exec = (file, args, opts) => args.includes('rev-list') ? Array(257).fill(f.to).join('\n') : (f.exec || realExec)(file, args, opts);
  const result = classify(f, { exec }); assert.equal(result.carries, false); assert.match(result.reason, /256.*re-audit/);
});
import { execFileSync as realExec } from 'node:child_process';
test('findings match exact text including line numbers and whitespace', () => {
  assert.equal(findingsSubset(['x.js:10 — a'], ['x.js:12 — a']), false);
  for (const value of ['code.js:123:5 issue', 'line 123 issue', 'L123 issue', ' a  b ']) {
    assert.equal(normalizeFinding(value), value);
    assert.equal(findingsSubset([value], [value]), true);
  }
  assert.equal(findingsSubset(['New'], ['new']), false);
  assert.equal(findingsSubset([], ['old']), false);
});
function waiver(f, { findings = ['code.js:10 issue'], ruling = 'R12', records, ruledFindings = ['code.js:10 issue', 'second issue'] } = {}) {
  const ref = 'lane/example', entry = { ref, sha: f.from, ruling: 'R12', findings: ruledFindings };
  const ready = { ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: ruling, auditDisclosed: findings };
  const sameContent = createSameContentProof(f);
  const gate = readyEvidence(records || [ready], { branch: ref, sha: f.to }, [entry], null, { sameContent });
  const audit = { head: f.to, base: f.root, verdict: 'WEAKENED', findings, questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z' };
  return { gate, audit, result: canonicalAuditEvidence([audit], f.to, () => true, null, { ruledWeakened: gate, sameContent }) };
}
test('waiver exact subset carries; canonical new findings refuse', t => {
  const f = fixture(t, 'clean'), w = waiver(f); assert.ok(w.gate); assert.equal(w.result.ok, true);
  assert.equal(waiver(f, { findings: ['new issue'] }).gate, null);
  assert.equal(waiver(f, { ruling: 'R99' }).gate, null);
  const newAudit = { ...w.audit, findings: ['new issue'] };
  assert.equal(canonicalAuditEvidence([newAudit], f.to, () => true, null, { ruledWeakened: w.gate }).ok, false);
});
test('waiver refuses non-merge code changes', t => { assert.equal(waiver(fixture(t, 'code')).gate, null); });
test('latest ready negative evidence cannot be bypassed', t => {
  const f = fixture(t, 'clean'), ref = 'lane/example';
  const old = { ref, sha: f.from, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: ['code.js issue'] };
  assert.equal(waiver(f, { records: [old, { ...old, tests: 'red' }] }).gate, null);
  assert.equal(waiver(f, { records: [old, { ...old, sha: f.to, tests: 'red' }] }).gate, null);
});
test('waiver logging is injectable and log/alert failures do not affect classification', t => {
  const f = fixture(t, 'clean'), proof = classify(f); let notices = 0;
  const record = { ref: 'lane/example', from: f.from, to: f.to, ruling: 'R12', matched: ['issue'], commits: proof.commits };
  const path = join(f.repo, 'ops', 'carry.jsonl'); recordWaiverCarry(record, { path, notify() { notices++; } });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).commits, proof.commits); assert.equal(notices, 1);
  assert.doesNotThrow(() => recordWaiverCarry(record, { path, append() { throw Error('disk'); }, notify() { throw Error('alert'); } }));
});
for (const kind of ['clean', 'jit', 'code', 'test']) test(`review and red-team ${kind} carry policy`, t => {
  const f = fixture(t, kind), expected = ['clean', 'jit'].includes(kind);
  const record = { sha: f.from, diff: 'a'.repeat(64), humanCleared: true };
  const facts = { ...f, setting: 'on', record, headSha: f.to, headDiff: 'b'.repeat(64), equivalence: 'strict',
    exec: realExec, fingerprint: () => record.diff };
  const accept = decideAcceptCarryForward(facts); assert.equal(accept.action === 'carry', expected);
  const red = decideRebaseVerdictCarry({ ...f, setting: 'on', prior: record, priorPatchId: 'a'.repeat(40), headPatchId: 'b'.repeat(40), headSha: f.to });
  assert.equal(red.carry, expected);
  if (expected) { assert.ok(accept.commits.length); assert.deepEqual(parseVerdictCarriedMarker(buildVerdictCarriedMarker({ fromSha: f.from, toSha: f.to, commits: red.commits })).commits, red.commits); }
  for (const hold of ['laterVerdict', 'laterBodyDerivedHold', 'reviewsUnreadable'])
    assert.notEqual(decideAcceptCarryForward({ ...facts, record: { ...record, [hold]: true } }).action, 'carry');
  assert.equal(decideRebaseVerdictCarry({ ...f, setting: 'on', prior: { ...record, laterVerdict: true }, headSha: f.to }).carry, false);
});

import { checkCanonicalAuditForOpen } from '../../operations/canonical-audit-gate.mjs';
test('PR admission carries an exact canonical subset, logs once, and refuses new findings or setting off', t => {
  const f = fixture(t, 'clean'), ref = 'lane/example';
  const path = join(f.repo, 'audits.jsonl');
  const entry = { ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue', 'second issue'] };
  const audit = { head: f.to, base: f.root, verdict: 'WEAKENED', findings: ['code.js:12 issue'], questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z' };
  let emitted = [];
  const check = (findings = audit.findings, env = f.env, recordCarry = record => emitted.push(record)) => checkCanonicalAuditForOpen({
    repo: f.repo, ref, sha: f.to, env: { ...env, WE_PLATFORM_PREFERENCES_FILE: join(f.repo, 'prefs.json') },
    readFile(file) {
      if (String(file).endsWith('/settings/prototype-load.json')) return JSON.stringify({ auditRecordPath: path, ruledWeakened: [entry] });
      if (file === path) return JSON.stringify({ ...audit, findings });
      throw Object.assign(Error('missing fixture file'), { code: 'ENOENT' });
    }, fetchMain() {}, liveFingerprint: () => null, recordCarry, warn() {},
  });
  assert.equal(check().ok, true); assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].commits, [{ sha: f.to, kind: 'clean-main-merge' }]);
  assert.equal(check(['new issue']).ok, false); assert.equal(emitted.length, 1);
  assert.equal(check([], f.env).ok, false);
  assert.equal(check(audit.findings, { ...f.env, WE_SAME_DIFF_CARRY: 'off' }).ok, false);
  assert.equal(check(audit.findings, f.env, () => { throw Error('disk/alert failure'); }).ok, true);
});

import { makeAuditedTipGate } from '../daemon-rebuild/audited-tip.mjs';
test('daemon waiver carry requires canonical subset admission on the correct repository', t => {
  const f = fixture(t, 'clean'), ref = 'lane/example', path = join(f.repo, 'ready.jsonl'), platform = join(f.repo, 'platform.json');
  f.write('ready.jsonl', JSON.stringify({ ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: ['code.js:12 issue'] }));
  f.write('platform.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [{ ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue', 'other issue'] }] } }));
  const env = { ...f.env, HOME: f.repo, WE_FIX_READY_PATH: path, WE_PLATFORM_PREFERENCES_FILE: platform, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
  for (const ok of [false, true]) {
    let calls = 0;
    const gate = makeAuditedTipGate(env, { repo: f.repo, canonicalAudit(facts) {
      calls++; assert.equal(facts.repo, f.repo); assert.equal(facts.sha, f.to);
      assert.equal(facts.sameContent(f.from, f.to).carries, true); return { ok, record: { findings: ['code.js:12 issue'] } };
    } });
    assert.equal(gate(ref, f.to), ok); assert.equal(calls, 1);
  }
  const mismatched = makeAuditedTipGate(env, { repo: f.repo, canonicalAudit() {
    return { ok: true, record: { findings: ['other issue'] } };
  } });
  assert.equal(mismatched(ref, f.to), false);
});
test('test allowance never hides mixed-path renames, non-test deletions or submodules', t => {
  for (const change of ['rename', 'delete', 'submodule']) {
    const f = fixture(t, 'test');
    if (change === 'rename') f.git('mv', 'conflict.js', 'code.test.js');
    if (change === 'delete') f.git('rm', 'conflict.js');
    if (change === 'submodule') f.git('update-index', '--add', '--cacheinfo', `160000,${f.from},__tests__/submodule`);
    // Preserve the explicitly staged gitlink; no working file exists for it.
    f.git('commit', '-qm', change); const to = f.git('rev-parse', 'HEAD');
    assert.equal(classify(f, { from: f.to, to, allowTestOnly: true }).carries, false, change);
  }
});
test('bounded Git output failures refuse and retain the operator fallback', t => {
  const f = fixture(t, 'clean');
  const result = classify(f, { exec(file, args, options) {
    assert.equal(options.maxBuffer, 8 * 1024 * 1024); assert.equal(options.timeout, 10000);
    throw Object.assign(Error('too much output'), { code: 'ENOBUFS' });
  } });
  assert.equal(result.carries, false); assert.match(result.reason, /re-audit\/re-review/);
});

test('history carry records remain recognized machine evidence and malformed commit kinds refuse', () => {
  const fromSha = 'a'.repeat(40), toSha = 'b'.repeat(40);
  const marker = buildVerdictCarriedMarker({ fromSha, toSha, commits: [{ sha: toSha, kind: 'jit-rename' }] });
  const body = `${marker}\nReview verdict carried across an identical contribution.`;
  assert.equal(isKnownMachineBody(body, { author: { login: 'chalbert' }, body }), true);
  assert.equal(parseVerdictCarriedMarker(marker.replace('jit-rename', 'test-only')), null);
  assert.equal(parseVerdictCarriedMarker(marker.replace('jit-rename', 'jit-rename:extra')), null);
});

test('changed source lines and endpoint ports refuse waiver admission', t => {
  const f = fixture(t, 'clean');
  const ruled = 'code.js:12 connects to http://127.0.0.1:8000';
  const accepted = waiver(f, { findings: [ruled], ruledFindings: [ruled] });
  assert.equal(accepted.result.ok, true);
  for (const changed of ['code.js:100 connects to http://127.0.0.1:8000',
    'code.js:12 connects to http://127.0.0.1:9000']) {
    assert.equal(findingsSubset([changed], [ruled]), false);
    assert.equal(waiver(f, { findings: [changed], ruledFindings: [ruled] }).gate, null);
  }
});

test('old NOT WEAKENED readiness cannot authorize a test-only successor through either consumer', t => {
  const f = fixture(t, 'test'), ref = 'lane/example';
  const sameContent = createSameContentProof(f);
  assert.equal(sameContent(f.from, f.to).carries, true);
  assert.deepEqual(sameContent(f.from, f.to).commits, [{ sha: f.to, kind: 'test-only' }]);
  const ready = { ref, sha: f.from, tests: 'green', audit: 'NOT WEAKENED' };
  const entry = { ref, sha: f.from, ruling: 'R12', findings: ['code.js issue'] };
  assert.ok(readyEvidence([ready], { branch: ref, sha: f.from }, [entry], null, { sameContent }));
  assert.equal(readyEvidence([ready], { branch: ref, sha: f.to }, [entry], null, { sameContent }), null);
  f.write('ready.jsonl', JSON.stringify(ready));
  f.write('platform.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [entry] } }));
  const env = { ...f.env, HOME: f.repo, WE_FIX_READY_PATH: join(f.repo, 'ready.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(f.repo, 'platform.json'), WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
  let canonicalCalls = 0;
  const gate = makeAuditedTipGate(env, { repo: f.repo, canonicalAudit() { canonicalCalls++; return { ok: true }; } });
  assert.equal(gate(ref, f.from), true);
  assert.equal(gate(ref, f.to), false);
  assert.equal(canonicalCalls, 0);
});
test('newer negative ordinary readiness still vetoes a history-carried waiver', t => {
  const f = fixture(t, 'test'), ref = 'lane/example';
  f.write('another.test.mjs', 'second test change\n');
  const to = f.commit('second test-only successor');
  const sameContent = createSameContentProof(f);
  const entry = { ref, sha: f.from, ruling: 'R12', findings: ['code.js issue'] };
  const ruled = { ref, sha: f.from, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: entry.findings };
  const negative = { ref, sha: f.to, tests: 'red', audit: 'NOT WEAKENED', fingerprint: 'b'.repeat(64) };
  const liveReady = { ...ruled, sha: to };
  assert.equal(readyEvidence([ruled], { branch: ref, sha: to }, [entry], 'c'.repeat(64), { sameContent }), null);
  assert.ok(readyEvidence([liveReady], { branch: ref, sha: to }, [entry], 'c'.repeat(64), { sameContent }));
  assert.equal(readyEvidence([liveReady, negative], { branch: ref, sha: to }, [entry], 'c'.repeat(64), { sameContent }), null);
});

test('acceptance mismatch without injected IO stays settled and never invokes history dependencies', () => {
  const record = { sha: 'a'.repeat(40), diff: 'a'.repeat(64), humanCleared: true };
  let calls = 0;
  const unexpected = () => { calls++; throw Error('unexpected history dependency'); };
  assert.deepEqual(decideAcceptCarryForward({ setting: 'on', record, headSha: 'b'.repeat(40),
    headDiff: 'b'.repeat(64), fingerprint: unexpected, classify: unexpected }), {
    from: record.sha, to: 'b'.repeat(40), human: true, action: 'review-owed',
    reason: `net diff changed since the accept at ${record.sha.slice(0, 9)} — a review of the change is owed; it goes back to the operator`,
  });
  assert.equal(calls, 0);
});

test('acceptance history kill switch performs no injected Git reads', () => {
  let calls = 0;
  const result = decideAcceptCarryForward({ setting: 'on', env: { WE_SAME_DIFF_CARRY: 'off' },
    record: { sha: 'a'.repeat(40), diff: 'a'.repeat(64) }, headSha: 'b'.repeat(40), headDiff: 'b'.repeat(64),
    exec() { calls++; throw Error('history is disabled'); } });
  assert.equal(result.action, 'review-owed'); assert.equal(result.retryable, undefined); assert.equal(calls, 0);
});

for (const kind of ['clean', 'jit', 'code', 'conflict-code', 'test'])
  test(`acceptance authentic fingerprint and injected Git: ${kind}`, t => {
    const f = fixture(t, kind), calls = [];
    const record = { sha: f.from, diff: netDiffFingerprint(f.repo, 'origin/main', f.from), humanCleared: true };
    const headDiff = netDiffFingerprint(f.repo, 'origin/main', f.to);
    assert.ok(record.diff); assert.ok(headDiff); assert.notEqual(record.diff, headDiff);
    const exec = (file, args, options) => {
      calls.push(args);
      assert.equal(file, 'git'); assert.deepEqual(args.slice(0, 2), ['-C', f.repo]);
      assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 8 * 1024 * 1024);
      assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
      assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
      return realExec(file, args, options);
    };
    const result = decideAcceptCarryForward({ ...f, exec, setting: 'on', record, headSha: f.to, headDiff, equivalence: 'strict' });
    assert.ok(calls.length);
    assert.equal(result.action, ['clean', 'jit'].includes(kind) ? 'carry' : 'review-owed');
    assert.equal(result.retryable, undefined);
    if (result.action === 'review-owed') assert.equal(result.reason,
      `net diff changed since the accept at ${record.sha.slice(0, 9)} — a review of the change is owed; it goes back to the operator`);
  });

test('a clean history cannot carry a fingerprint that does not cover the accepted commit', t => {
  const f = fixture(t, 'clean');
  let historyCalls = 0;
  const result = decideAcceptCarryForward({ ...f, exec: realExec, setting: 'on',
    record: { sha: f.from, diff: 'a'.repeat(64), humanCleared: true },
    headSha: f.to, headDiff: netDiffFingerprint(f.repo, 'origin/main', f.to),
    classify: () => { historyCalls++; return { carries: true, commits: [] }; } });
  assert.equal(historyCalls, 0);
  assert.equal(result.action, 'review-owed'); assert.equal(result.retryable, undefined);
  assert.match(result.reason, /^net diff changed since the accept/);
  assert.doesNotMatch(result.reason, /reviewed-sha|cleared-human|reviewed-diff/);
});

test('unreadable or oversized accepted fingerprint preserves the settled refusal without ambient IO', t => {
  const f = fixture(t, 'clean');
  for (const code of ['ENOENT', 'ENOBUFS']) {
    let calls = 0, historyCalls = 0;
    const result = decideAcceptCarryForward({ ...f, setting: 'on',
      record: { sha: f.from, diff: 'a'.repeat(64) }, headSha: f.to, headDiff: 'b'.repeat(64),
      exec(file, args, options) {
        calls++; assert.equal(file, 'git'); assert.equal(options.maxBuffer, 8 * 1024 * 1024);
        throw Object.assign(Error('unavailable proof'), { code });
      }, classify: () => { historyCalls++; return { carries: true, commits: [] }; } });
    assert.equal(calls, 1); assert.equal(historyCalls, 0); assert.equal(result.action, 'review-owed');
    assert.equal(result.retryable, undefined); assert.match(result.reason, /^net diff changed since the accept/);
  }
});


// Audit round 1: evidence is always fresh after any test edit, including merge resolutions.
for (const kind of ['test', 'conflict-test']) test(`${kind}: old WEAKENED tests and audits never authorize the successor`, t => {
  const f = fixture(t, kind), ref = 'lane/example', sameContent = createSameContentProof(f);
  const fp = 'c'.repeat(64);
  const entry = { ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue'] };
  const old = { ref, sha: f.from, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: entry.findings, fingerprint: fp };
  const live = { ...old, sha: f.to };
  assert.equal(readyEvidence([old], { branch: ref, sha: f.to }, [entry], fp, { sameContent }), null);
  const gate = readyEvidence([live], { branch: ref, sha: f.to }, [entry], fp, { sameContent });
  assert.ok(gate);
  const audit = { head: f.from, base: f.root, verdict: 'WEAKENED', findings: entry.findings,
    questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z', fingerprint: 'd'.repeat(64) };
  for (const verdict of ['WEAKENED', 'NOT WEAKENED']) {
    const prior = { ...audit, verdict, findings: verdict === 'WEAKENED' ? entry.findings : [] };
    assert.equal(canonicalAuditEvidence([prior], f.to, () => true, fp, { sameContent, ruledWeakened: gate }).ok, false);
  }
  assert.equal(canonicalAuditEvidence([{ ...audit, head: f.to }], f.to, () => true, fp,
    { sameContent, ruledWeakened: gate }).ok, true);
  // A mismatched fingerprint cannot lend predecessor audit evidence.
  assert.equal(canonicalAuditEvidence([{ ...audit, verdict: 'NOT WEAKENED', findings: [] }], f.to, () => true, fp,
    { ruledWeakened: gate }).ok, false);
  f.write('ready.jsonl', JSON.stringify(old));
  f.write('platform.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [entry] } }));
  const env = { ...f.env, HOME: f.repo, WE_FIX_READY_PATH: join(f.repo, 'ready.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(f.repo, 'platform.json'), WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
  let calls = 0;
  assert.equal(makeAuditedTipGate(env, { repo: f.repo, canonicalAudit() { calls++; return { ok: true }; } })(ref, f.to), false);
  assert.equal(calls, 0);
  f.write('ready.jsonl', JSON.stringify(live));
  for (const ok of [false, true]) {
    assert.equal(makeAuditedTipGate(env, { repo: f.repo, canonicalAudit() { return { ok, record: { findings: entry.findings } }; } })(ref, f.to), ok);
  }
});

for (const change of ['delete', 'net-removal', 'merge-net-removal']) test(`waiver refuses test ${change} with a fresh-audit fallback`, t => {
  const f = fixture(t, 'test');
  let from = f.to;
  if (change === 'delete') f.git('rm', 'sample.test.mjs');
  else if (change === 'net-removal') {
    f.write('sample.test.mjs', 'assert one\nassert two\nassert three\n');
    from = f.commit('assertions');
    f.write('sample.test.mjs', 'assert one\n');
  } else {
    f.git('checkout', '-q', 'main');
    f.write('main.txt', 'main change\n');
    const main = f.commit('main advance');
    f.git('update-ref', 'refs/remotes/origin/main', main);
    f.git('checkout', '-q', 'lane');
    f.git('merge', '--no-commit', 'main');
    f.write('sample.test.mjs', '');
  }
  const to = f.commit(change);
  const result = classify(f, { from, to, allowTestOnly: true });
  assert.equal(result.carries, false);
  assert.match(result.reason, /re-audit\/re-review the current head/);
});

test('finding multiset consumes distinct rulings and preserves source paths', t => {
  const ruled = ['src/a.js:12 issue'];
  const live = ['src/a.js:12 issue', 'src/a.js:12 issue'];
  assert.equal(findingsSubset(live, ruled), false);
  assert.equal(findingsSubset(live, [...ruled, 'src/a.js:12 issue']), true);
  assert.equal(findingsSubset(['src/b.js:30 issue'], ruled), false);
  const f = fixture(t, 'test');
  const accepted = waiver(f, { findings: live, ruledFindings: [...ruled, 'src/a.js:12 issue'] });
  assert.equal(accepted.result.ok, true);
  assert.equal(waiver(f, { findings: live, ruledFindings: ruled }).gate, null);
  assert.equal(canonicalAuditEvidence([accepted.audit], f.to, () => true, null, {
    ruledWeakened: { ...accepted.gate, ruledWeakened: { ruling: 'R12', findings: ruled } },
    sameContent: createSameContentProof(f),
  }).ok, false);
});

import { createPrLandRunner } from '../../operations/open-pr-io.mjs';
test('open-pr requires a fresh canonical audit after test edits; only its findings receive the carried waiver', t => {
  const f = fixture(t, 'test'), ref = 'lane/example';
  const path = join(f.repo, 'audits.jsonl'), fp = 'c'.repeat(64);
  const entry = { ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue'] };
  const old = { head: f.from, base: f.root, questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z',
    verdict: 'WEAKENED', findings: entry.findings, fingerprint: fp };
  let records = [old], published = 0;
  const check = () => checkCanonicalAuditForOpen({ repo: f.repo, ref, sha: f.to,
    env: { ...f.env, HOME: f.repo, WE_PLATFORM_PREFERENCES_FILE: join(f.repo, 'prefs.json') },
    readFile(file) {
      if (String(file).endsWith('/settings/prototype-load.json')) return JSON.stringify({ auditRecordPath: path, ruledWeakened: [entry] });
      if (file === path) return records.map(r => JSON.stringify(r)).join('\n');
      throw Object.assign(Error('missing fixture file'), { code: 'ENOENT' });
    }, fetchMain() {}, liveFingerprint: () => fp, recordCarry() {}, warn() {},
  });
  const run = createPrLandRunner({ cwd: f.repo, env: f.env, canonicalAudit: check, prePrReview: () => ({ action: 'pass' }),
    prepGate: () => ({ ok: true }), readPrepBody: () => '', spawn() { published++; return { status: 0, stdout: '{"pr":7}' }; } });
  const open = () => run({ argv: [`--ref=${ref}`, `--sha=${f.to}`] });
  assert.equal(open().outcome, 'refused');
  assert.equal(published, 0);
  records = [old, { ...old, head: f.to, findings: ['code.js:12 issue'], at: '2026-11-02T00:00:00Z' }];
  assert.equal(open().outcome, 'opened');
  records[1] = { ...records[1], findings: ['code.js:50 issue', 'code.js:60 issue'] };
  assert.equal(open().outcome, 'refused');
  records[1] = { ...records[1], findings: ['other.js:50 issue'] };
  assert.equal(open().outcome, 'refused');
  assert.equal(published, 1);
});

import { createReviewJobIo } from '../../operations/review-job.mjs';
test('replacement objects cannot disguise a code change in classifier or review wrapper', t => {
  const f = fixture(t, 'code');
  f.git('checkout', '-q', '--detach', f.from);
  f.git('mv', 'backlog/xabc-story.md', 'backlog/7456-story.md');
  const benign = f.commit('benign rename');
  f.git('replace', f.to, benign);
  const env = { ...f.env, GIT_NO_REPLACE_OBJECTS: '0', GIT_GRAFT_FILE: 'hostile' };
  // The caller explicitly tries to disable replacement protection.
  assert.equal(f.git('rev-parse', `${f.to}^{tree}`), f.git('rev-parse', `${benign}^{tree}`));
  assert.equal(classify(f, { env }).carries, false);
  const calls = [];
  const io = createReviewJobIo({ env, log() {}, exec(file, args, options) {
    calls.push(options);
    return realExec(file, ['-C', f.repo, ...args.slice(2)], options);
  } });
  assert.equal(io.sameContentMove({ from: f.from, to: f.to, repo: 'web-everything/web-everything' }).carries, false);
  assert.ok(calls.length);
  // Assert outside the classifier's fail-closed catch so an assertion cannot masquerade as refusal.
  for (const options of calls) {
    assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(options.env.GIT_GRAFT_FILE, '/dev/null');
    const pins = Array.from({ length: Number(options.env.GIT_CONFIG_COUNT) }, (_, i) =>
      [options.env[`GIT_CONFIG_KEY_${i}`], options.env[`GIT_CONFIG_VALUE_${i}`]]);
    assert.deepEqual(pins.filter(([key]) => key === 'core.commitGraph').at(-1), ['core.commitGraph', 'false']);
  }
});
test('grafts and caller history config cannot change a genuine clean-merge proof', t => {
  const f = fixture(t, 'clean');
  f.git('commit-graph', 'write', '--reachable');
  f.write('.git/info/grafts', `${f.to}\n`);
  assert.equal(f.git('show', '-s', '--format=%P', f.to), '');
  const env = { ...f.env, GIT_GRAFT_FILE: join(f.repo, '.git/info/grafts'),
    GIT_NO_REPLACE_OBJECTS: '0', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true' };
  assert.deepEqual(classify(f, { env }).commits, [{ sha: f.to, kind: 'clean-main-merge' }]);
  assert.equal(classify(f, { env }).carries, true);
});
for (const kind of ['clean', 'jit']) test(`${kind}: predecessor green never supplies live readiness or history-only audit`, t => {
  const f = fixture(t, kind), ref = 'lane/example', sameContent = createSameContentProof(f);
  for (const fingerprint of [undefined, 'b'.repeat(64), 'c'.repeat(64)]) {
    for (const audit of ['WEAKENED', 'NOT WEAKENED']) {
      const entry = { ref, sha: f.from, ruling: 'R12', findings: ['issue'] };
      const old = { ref, sha: f.from, fingerprint, tests: 'green', audit,
        auditRuling: 'R12', auditDisclosed: entry.findings };
      assert.equal(readyEvidence([old], { branch: ref, sha: f.to }, [entry], 'c'.repeat(64), { sameContent }), null);
      const live = { ...old, sha: f.to };
      const gate = readyEvidence([live], { branch: ref, sha: f.to }, [entry], 'c'.repeat(64), { sameContent });
      assert.ok(gate);
      const record = { head: f.from, base: f.root, fingerprint, verdict: audit,
        findings: audit === 'WEAKENED' ? entry.findings : [], questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z' };
      if (fingerprint !== 'c'.repeat(64)) assert.equal(canonicalAuditEvidence([record], f.to, () => true,
        'c'.repeat(64), { sameContent, ruledWeakened: gate }).ok, false);
    }
  }
});


test('carried ready [A] and ruling [A,B] refuse canonical [B], reordered or duplicated disclosure', t => {
  const f = fixture(t, 'clean');
  const w = waiver(f, { findings: ['A'], ruledFindings: ['A', 'B'] });
  assert.ok(w.gate);
  assert.deepEqual(w.gate.ruledWeakened.findings, ['A']);
  for (const findings of [['B'], ['A', 'B'], ['A', 'A'], []]) {
    assert.equal(canonicalAuditEvidence([{ ...w.audit, findings }], f.to, () => true, null,
      { ruledWeakened: w.gate }).ok, false);
  }
  const both = waiver(f, { findings: ['A', 'B'], ruledFindings: ['A', 'B'] });
  assert.equal(both.result.ok, true);
  assert.equal(canonicalAuditEvidence([{ ...both.audit, findings: ['B', 'A'] }], f.to, () => true, null,
    { ruledWeakened: both.gate }).ok, false);
  assert.equal(waiver(f, { findings: ['A', 'A'], ruledFindings: ['A', 'B'] }).gate, null);
});

function assertProofEnv(options) {
  assert.equal(options.env.GIT_GRAFT_FILE, '/dev/null');
  assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
  const pins = Array.from({ length: Number(options.env.GIT_CONFIG_COUNT) }, (_, i) =>
    [options.env[`GIT_CONFIG_KEY_${i}`], options.env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.deepEqual(pins.filter(([key]) => key === 'core.commitGraph').at(-1), ['core.commitGraph', 'false']);
}
const hostileHistoryEnv = f => ({ ...f.env, GIT_GRAFT_FILE: join(f.repo, '.git/info/grafts'),
  GIT_NO_REPLACE_OBJECTS: '0', GIT_NO_LAZY_FETCH: '0', GIT_TERMINAL_PROMPT: '1',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true' });

test('accept proof preserves caller options but refuses a fingerprint forged with grafts', t => {
  const f = fixture(t, 'clean');
  const genuine = netDiffFingerprint(f.repo, 'origin/main', f.from);
  const main = f.git('rev-parse', 'origin/main');
  f.write('.git/info/grafts', `${f.from} ${main}\n`);
  // Deliberately read the hostile history without the production helper to construct the forged fingerprint.
  const forged = normalizeDiffFingerprint(f.git('diff', main, f.from));
  assert.notEqual(forged, genuine);
  const calls = [];
  let classifications = 0;
  const result = decideAcceptCarryForward({ ...f, env: hostileHistoryEnv(f), setting: 'on',
    record: { sha: f.from, diff: forged }, headSha: f.to, headDiff: 'b'.repeat(64),
    exec(file, args, options) { calls.push(options); return realExec(file, args, options); },
    classify() { classifications++; return { carries: true, commits: [] }; } });
  assert.equal(result.action, 'review-owed');
  assert.equal(classifications, 0);
  assert.ok(calls.length);
  calls.forEach(assertProofEnv);
  const accepted = decideAcceptCarryForward({ ...f, env: hostileHistoryEnv(f), setting: 'on',
    record: { sha: f.from, diff: genuine }, headSha: f.to, headDiff: 'b'.repeat(64),
    exec(file, args, options) { calls.push(options); return realExec(file, args, options); } });
  assert.equal(accepted.action, 'carry');
  calls.forEach(assertProofEnv);
});

import { normalizeDiffFingerprint } from '../review-escalation.mjs';
test('adjacent proof runners override hostile caller history settings', t => {
  const f = fixture(t, 'clean'), env = hostileHistoryEnv(f), calls = [];
  const real = (file, args, options) => { calls.push(options); return realExec(file, args, { ...options, cwd: f.repo }); };
  assert.ok(netDiffFingerprint(f.repo, 'origin/main', f.from, { exec: real, env }));
  assert.ok(contributionPatchId({ exec: real, sha: f.from, env }));
  const io = createReviewJobIo({ env, log() {}, exec: real });
  assert.ok(io.contributionPatchId({ sha: f.from, repo: 'web-everything/web-everything' }));
  assert.ok(calls.length);
  calls.forEach(assertProofEnv);
});
