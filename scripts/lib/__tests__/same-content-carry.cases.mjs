import { execFileSync as realExec } from 'node:child_process';
import { contributionPatchId } from '../rebase-verdict-carry.mjs';
import { createReviewJobIo } from '../../operations/review-job.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameContentRepo } from './fixtures/same-content-repo.mjs';
import { classifyHeadMove, findingsEqual, resolveSameDiffCarry } from '../same-content-carry.mjs';
import { createSameContentProof, recordWaiverCarry } from '../same-content-waiver-io.mjs';
import { netDiffFingerprint } from '../net-diff-fingerprint.mjs';
import { readyEvidence, canonicalAuditEvidence } from '../../operations/prototype-load.mjs';
import { QUESTION_HASH } from '../../operations/codex-audit.mjs';
function fixture(t, kind) { const f = sameContentRepo(kind); t.after(f.cleanup); return f; }
const classify = (f, extra = {}) => classifyHeadMove({ ...f, ...extra });
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
test('findings match exact text including line numbers and whitespace', () => {
  assert.equal(findingsEqual(['x.js:10 — a'], ['x.js:12 — a']), false);
  for (const value of ['code.js:123:5 issue', 'line 123 issue', 'L123 issue', ' a  b ']) {
    assert.equal(findingsEqual([value], [value]), true);
  }
  assert.equal(findingsEqual(['New'], ['new']), false);
  assert.equal(findingsEqual([], ['old']), false);
});
function waiver(f, { findings = ['code.js:10 issue'], ruling = 'R12', records, ruledFindings = ['code.js:10 issue'] } = {}) {
  const ref = 'lane/example', entry = { ref, sha: f.from, ruling: 'R12', findings: ruledFindings };
  const ready = { ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: ruling, auditDisclosed: findings };
  const sameContent = createSameContentProof(f);
  const gate = readyEvidence(records || [ready], { branch: ref, sha: f.to }, [entry], null, { sameContent });
  const audit = { head: f.to, base: f.root, verdict: 'WEAKENED', findings, questionHash: QUESTION_HASH, at: '2026-11-01T00:00:00Z' };
  return { gate, audit, result: canonicalAuditEvidence([audit], f.to, () => true, null, { ruledWeakened: gate, sameContent }) };
}
test('waiver exact findings carry; canonical new findings refuse', t => {
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
import { checkCanonicalAuditForOpen } from '../../operations/canonical-audit-gate.mjs';
test('PR admission carries an exact canonical findings, logs once, and refuses new findings or setting off', t => {
  const f = fixture(t, 'clean'), ref = 'lane/example';
  const path = join(f.repo, 'audits.jsonl');
  const entry = { ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue'] };
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
test('daemon waiver carry requires canonical exact admission on the correct repository', t => {
  const f = fixture(t, 'clean'), ref = 'lane/example', path = join(f.repo, 'ready.jsonl'), platform = join(f.repo, 'platform.json');
  f.write('ready.jsonl', JSON.stringify({ ref, sha: f.to, tests: 'green', audit: 'WEAKENED', auditRuling: 'R12', auditDisclosed: ['code.js:12 issue'] }));
  f.write('platform.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [{ ref, sha: f.from, ruling: 'R12', findings: ['code.js:12 issue'] }] } }));
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
test('bounded Git output failures refuse and retain the operator fallback', t => {
  const f = fixture(t, 'clean');
  const result = classify(f, { exec(file, args, options) {
    assert.equal(options.maxBuffer, 8 * 1024 * 1024); assert.equal(options.timeout, 10000);
    throw Object.assign(Error('too much output'), { code: 'ENOBUFS' });
  } });
  assert.equal(result.carries, false); assert.match(result.reason, /re-audit\/re-review/);
});

test('changed source lines and endpoint ports refuse waiver admission', t => {
  const f = fixture(t, 'clean');
  const ruled = 'code.js:12 connects to http://127.0.0.1:8000';
  const accepted = waiver(f, { findings: [ruled], ruledFindings: [ruled] });
  assert.equal(accepted.result.ok, true);
  for (const changed of ['code.js:100 connects to http://127.0.0.1:8000',
    'code.js:12 connects to http://127.0.0.1:9000']) {
    assert.equal(findingsEqual([changed], [ruled]), false);
    assert.equal(waiver(f, { findings: [changed], ruledFindings: [ruled] }).gate, null);
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
for (const kind of ['clean']) test(`${kind}: predecessor green never supplies live readiness or history-only audit`, t => {
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
      if (gate.sameContentCarry || fingerprint !== 'c'.repeat(64)) assert.equal(canonicalAuditEvidence([record], f.to, () => true,
        'c'.repeat(64), { sameContent, ruledWeakened: gate }).ok, false);
    }
  }
});


test('carried ready [A] and ruling [A,B] refuse canonical [B], reordered or duplicated disclosure', t => {
  const f = fixture(t, 'clean');
  const w = waiver(f, { findings: ['A'], ruledFindings: ['A', 'B'] });
  assert.equal(w.gate, null);
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

test('only a clean automatic main merge carries a waiver', t => {
  const f = fixture(t, 'clean'), result = classify(f);
  assert.equal(result.carries, true, result.reason);
  assert.deepEqual(result.commits, [{ sha: f.to, kind: 'clean-main-merge' }]);
  assert.notEqual(netDiffFingerprint(f.repo, 'origin/main', f.from), netDiffFingerprint(f.repo, 'origin/main', f.to));
});
for (const kind of ['test', 'jit', 'conflict-code', 'conflict-test', 'jit-edit', 'outside', 'code', 'octopus', 'mode'])
  test(`${kind} refuses history and waiver carry`, t => {
    const f = fixture(t, kind);
    assert.equal(classify(f).carries, false);
    assert.equal(waiver(f).gate, null);
  });
test('exact findings refuse subsets, reordered entries, duplicates and missing disclosure', t => {
  for (const findings of [['A'], ['B', 'A'], ['A', 'A']]) {
    assert.equal(findingsEqual(findings, ['A', 'B']), false);
    assert.equal(waiver(fixture(t, 'clean'), { findings, ruledFindings: ['A', 'B'] }).gate, null);
  }
  const f = fixture(t, 'clean'), w = waiver(f);
  assert.ok(w.gate);
  for (const tests of ['red', undefined]) {
    assert.equal(waiver(f, { records: [{ ...w.gate.record, tests }] }).gate, null);
  }
  const { auditDisclosed, ...record } = w.gate.record;
  assert.equal(canonicalAuditEvidence([w.audit], f.to, () => true, null,
    { ruledWeakened: { ...w.gate, record } }).ok, false);
});
test('replacement objects cannot disguise a changed commit', t => {
  const f = fixture(t, 'code');
  f.git('replace', f.to, f.from);
  assert.equal(classify(f, { env: { ...f.env, GIT_NO_REPLACE_OBJECTS: '0' } }).carries, false);
});
