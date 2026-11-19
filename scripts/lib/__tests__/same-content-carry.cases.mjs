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
import { decideRebaseVerdictCarry } from '../rebase-verdict-carry.mjs';
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
test('normalization removes all supported line references and preserves case', () => {
  for (const suffix of [':123', ':123-140', ':123:5']) assert.equal(normalizeFinding(` code.js${suffix}   issue `), 'code.js issue');
  for (const suffix of ['line 123', 'lines 12-14', 'L123']) assert.equal(normalizeFinding(`code.js ${suffix} issue`), 'code.js issue');
  assert.equal(findingsSubset(['New'], ['new']), false); assert.equal(findingsSubset([], ['old']), false);
});
function waiver(f, { findings = ['code.js:25 issue'], ruling = 'R12', records, ruledFindings = ['code.js:10 issue', 'second issue'] } = {}) {
  const ref = 'lane/example', entry = { ref, sha: f.from, ruling: 'R12', findings: ruledFindings };
  const ready = { ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: ruling, auditDisclosed: findings };
  const sameContent = createSameContentProof(f);
  const gate = readyEvidence(records || [ready], { branch: ref, sha: f.to }, [entry], null, { sameContent });
  const audit = { head: f.to, base: f.root, verdict: 'WEAKENED', findings, questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z' };
  return { gate, audit, result: canonicalAuditEvidence([audit], f.to, () => true, null, { ruledWeakened: gate, sameContent }) };
}
test('waiver subset and line shifts carry; canonical new findings refuse', t => {
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
test('PR admission carries a normalized canonical subset, logs once, and refuses new findings or setting off', t => {
  const f = fixture(t, 'clean'), ref = 'lane/example';
  const path = join(f.repo, 'audits.jsonl');
  const entry = { ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue', 'second issue'] };
  const audit = { head: f.to, base: f.root, verdict: 'WEAKENED', findings: ['code.js:100 issue'], questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z' };
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
  f.write('ready.jsonl', JSON.stringify({ ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: ['code.js:44 issue'] }));
  f.write('platform.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [{ ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue', 'other issue'] }] } }));
  const env = { ...f.env, HOME: f.repo, WE_FIX_READY_PATH: path, WE_PLATFORM_PREFERENCES_FILE: platform, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
  for (const ok of [false, true]) {
    let calls = 0;
    const gate = makeAuditedTipGate(env, { repo: f.repo, canonicalAudit(facts) {
      calls++; assert.equal(facts.repo, f.repo); assert.equal(facts.sha, f.to);
      assert.equal(facts.sameContent(f.from, f.to).carries, true); return { ok };
    } });
    assert.equal(gate(ref, f.to), ok); assert.equal(calls, 1);
  }
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

test('normalization preserves differing endpoint ports and refuses carried waiver admission', t => {
  const f = fixture(t, 'clean');
  const ruled = 'code.js:12 connects to http://127.0.0.1:8000';
  const shifted = 'code.js:100 connects to http://127.0.0.1:8000';
  const changed = 'code.js:100 connects to http://127.0.0.1:9000';
  assert.equal(classify(f, { allowTestOnly: true }).carries, true);
  assert.equal(normalizeFinding(ruled), normalizeFinding(shifted));
  assert.notEqual(normalizeFinding(ruled), normalizeFinding(changed));
  assert.equal(findingsSubset([changed], [ruled]), false);
  const accepted = waiver(f, { findings: [shifted], ruledFindings: [ruled] });
  assert.equal(accepted.result.ok, true);
  assert.equal(waiver(f, { findings: [changed], ruledFindings: [ruled] }).gate, null);
  assert.equal(canonicalAuditEvidence([{ ...accepted.audit, findings: [changed] }], f.to,
    () => true, null, { ruledWeakened: accepted.gate, sameContent: createSameContentProof(f) }).ok, false);
});
test('normalization preserves numeric finding content and URLs even when their path resembles source', () => {
  for (const content of ['http://127.0.0.1:8000', 'http://127.0.0.1:9000', '127.0.0.1:8000',
    'https://example.test:9000/src/server.js:123', 'http://[::1]:8000', 'retry:123', 'ratio:12:5'])
    assert.equal(normalizeFinding(content), content);
  for (const source of ['scripts/lib/tool.mjs', './scripts/tool.ts', '/src/tool.py'])
    assert.equal(normalizeFinding(`[${source}:123:5] issue`), `[${source}] issue`);
  assert.equal(normalizeFinding('unknown-extension.xyz:123 issue'), 'unknown-extension.xyz:123 issue');
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
  assert.ok(readyEvidence([ruled], { branch: ref, sha: to }, [entry], 'c'.repeat(64), { sameContent }));
  assert.equal(readyEvidence([ruled, negative], { branch: ref, sha: to }, [entry], 'c'.repeat(64), { sameContent }), null);
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
