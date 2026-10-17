import { it, expect } from 'vitest';
import { proveIdenticalNetPatch, resolveIdenticalNetPatchSetting } from '../identical-net-patch.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40), base = 'c'.repeat(40);
const diff = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n';
const exec = (different = false) => (cmd, args, opts) => {
  if (args[0] === 'merge-base') return base;
  if (args[0] === 'diff') return args.includes(a) ? diff : diff.replace('@@ -1 +1 @@', '@@ -2 +2 @@');
  if (args[0] === 'patch-id') return `${different && opts.input.includes('@@ -2') ? b : a} ${base}\n`;
  throw Error('unexpected git');
};
it('review regressions: rejects moving an approved edit between identical blocks through both writers', () => {
  const oldDiff = 'diff --git a/auth.mjs b/auth.mjs\n--- a/auth.mjs\n+++ b/auth.mjs\n@@ -2,7 +2,7 @@ function testOnlyAuthorization() {\n   const user = currentUser();\n   const role = user.role;\n   audit(role);\n-  return false;\n+  return true;\n }\n';
  for (const [variant, header] of ['@@ -22,7 +22,7 @@ function productionAuthorization() {',
    '@@ -22,7 +22,7 @@ function testOnlyAuthorization() {',
    '@@ -2,7 +2,7 @@ function productionAuthorization() {'].entries()) {
    const headDiff = oldDiff.replace('@@ -2,7 +2,7 @@ function testOnlyAuthorization() {', header);
    const run = (cmd, args, opts) => {
      if (args[0] === 'diff') return args.includes(a) ? oldDiff : headDiff;
      return exec()(cmd, args, opts);
    };
    expect(proveIdenticalNetPatch({ exec: run, fromSha: a, toSha: b })).toMatchObject({ ok: false });
    for (const human of [true, false]) {
      const pr = 54630 + variant * 2 + Number(human);
      const comments = [{ author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${a} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(oldDiff)} -->${human ? '\n<!-- cleared-human: chalbert -->' : ''}` }];
      const writes = [], state = { headRefOid: b, labels: ['review:pending'], comments };
      const writerExec = (cmd, args, opts) => cmd === 'git' ? run(cmd, args, opts) : writes.push(args);
      expect(applyHumanClearanceCarry({ pr, repo: 'owner/repo', exec: writerExec, log: () => {},
        evidence: { humanClearance: latestHumanClearance(comments), headSha: b, headDiffSha: b, headDiff },
        readLiveEvidence: () => ({ headSha: b, comments, reviews: [] }) })).toBeNull();
      // A definitive numbering refusal: the stub git cannot serve that proof, and an unreadable one stays retryable.
      expect(restampAfterNumbering({ repo: 'owner/repo', pr, exec: run, state, reviews: [],
        prove: () => ({ ok: false, reason: 'not a numbering-only move' }),
        guardReferrals: () => {}, readNetDiff: () => ({ scored: true, text: headDiff }),
        readLiveState: () => ({ state, reviews: [] }),
        provider: { postComment: (...args) => writes.push(args), setLabels: (...args) => writes.push(args) } })).toMatchObject({ action: 'refused' });
      expect(writes).toEqual([]);
    }
  }
});
it('review regressions: a definitive net-patch miss never settles a head the numbering proof could not read', () => {
  const comments = [{ author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${a} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(diff)} -->\n<!-- cleared-human: chalbert -->` }];
  const state = { headRefOid: b, labels: ['review:pending'], comments };
  const transient = { ok: false, retryable: true, reason: 'numbering proof failed: transient read' };
  const definitive = { ok: false, reason: 'not a numbering-only move' };
  const unreadable = (cmd, args) => { if (args[0] === 'merge-base') throw Error('transient'); return exec()(cmd, args); };
  // [numbering proof, net-patch git, expected action]: either retryable read keeps the head unsettled.
  for (const [n, [first, git, action]] of [[transient, exec(), 'retry'], [transient, unreadable, 'retry'],
    [definitive, unreadable, 'retry'], [definitive, exec(), 'refused']].entries()) {
    const writes = [];
    let proofs = 0;
    const step = () => restampAfterNumbering({ repo: 'owner/repo', pr: 54700 + n, exec: git, state, reviews: [],
      prove: () => { proofs++; return first; }, guardReferrals: () => {},
      readNetDiff: () => ({ scored: true, text: diff }), readLiveState: () => ({ state, reviews: [] }),
      provider: { postComment: (...args) => writes.push(args), setLabels: (...args) => writes.push(args) } });
    expect(step()).toMatchObject({ action });
    expect(step()?.action).toBe(action === 'retry' ? 'retry' : undefined);
    expect(proofs).toBe(action === 'retry' ? 2 : 1);
    expect(writes).toEqual([]);
  }
});
it('review regressions: a refusal while the numbering proof is switched off is not memoized', () => {
  const comments = [{ author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${a} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(diff)} -->\n<!-- cleared-human: chalbert -->` }];
  const state = { headRefOid: b, labels: ['review:pending'], comments };
  const step = numbering => restampAfterNumbering({ repo: 'owner/repo', pr: 54710, exec: exec(), state, reviews: [],
    numberingSetting: { value: numbering, source: 'test' }, netPatchSetting: { value: true, source: 'test' },
    prove: () => ({ ok: false, reason: 'not a numbering-only move' }), guardReferrals: () => {},
    readNetDiff: () => ({ scored: true, text: diff }), readLiveState: () => ({ state, reviews: [] }), provider: {} });
  expect(step(false)).toMatchObject({ action: 'refused', reason: expect.stringContaining('numbering carry disabled') });
  // Switching the numbering proof on is judged on the next pass, then the definitive verdict settles.
  expect(step(true)).toMatchObject({ action: 'refused', reason: expect.stringContaining('not a numbering-only move') });
  expect(step(true)).toBeNull();
});
it('refuses offset-only net patches on an unchanged base despite matching stable patch ids', () => {
  expect(proveIdenticalNetPatch({ exec: exec(), fromSha: a, toSha: b })).toMatchObject({ ok: false, different: true });
});
it('carries identical positioned net patches on the same base', () => {
  const run = (cmd, args, opts) => args[0] === 'diff' ? diff : exec()(cmd, args, opts);
  expect(proveIdenticalNetPatch({ exec: run, fromSha: a, toSha: b })).toMatchObject({ ok: true, tier: 'net-patch' });
});
it('requires the same positioned upstream movement on the base and head when bases differ', () => {
  const advancedBase = 'd'.repeat(40);
  const upstream = 'diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n+upstream\n context\n';
  for (const movement of [upstream.replace('1111111..2222222', '3333333..4444444'),
    upstream.replace('@@ -1 +1,2 @@', '@@ -9 +9,2 @@'),
    upstream.replace('+upstream', '+different'), null]) {
    const run = (cmd, args, opts) => {
      if (args[0] === 'merge-base') return args.includes(a) ? base : advancedBase;
      if (args[0] === 'diff' && args.includes(base) && args.includes(advancedBase)) return upstream;
      if (args[0] === 'diff' && args.includes(a) && args.includes(b)) {
        if (movement === null) throw Error('unreadable head delta');
        return movement;
      }
      return exec()(cmd, args, opts);
    };
    const proof = proveIdenticalNetPatch({ exec: run, fromSha: a, toSha: b });
    expect(proof.ok).toBe(movement === upstream.replace('1111111..2222222', '3333333..4444444'));
    if (movement === null) expect(proof.retryable).toBe(true);
  }
});
it('refuses any different patch id and unreadable or empty evidence', () => {
  expect(proveIdenticalNetPatch({ exec: exec(true), fromSha: a, toSha: b }).ok).toBe(false);
  for (const run of [() => '', () => { throw Error('unreadable'); }]) expect(proveIdenticalNetPatch({ exec: run, fromSha: a, toSha: b }).ok).toBe(false);
});
it('defaults on and preserves settings provenance and off switch', () => {
  expect(resolveIdenticalNetPatchSetting({ env: {}, tool: {}, platform: {} })).toMatchObject({ value: true, source: 'standard' });
  expect(resolveIdenticalNetPatchSetting({ env: { WE_REVIEW_CARRY_ACROSS_IDENTICAL_NET_PATCH: 'false' }, tool: {}, platform: {} })).toMatchObject({ value: false, source: 'env' });
});
it('keeps root-manifest whitespace even though contribution fingerprints omit that file', () => {
  const manifest = 'diff --git a/.lane-manifest.json b/.lane-manifest.json\n--- a/.lane-manifest.json\n+++ b/.lane-manifest.json\n@@ -1 +1 @@\n-old\n+{"value":"a b"}\n';
  const run = (cmd, args, opts) => args[0] === 'diff'
    ? diff + (args.includes(a) ? manifest : manifest.replace('a b', 'ab')) : exec()(cmd, args, opts);
  expect(proveIdenticalNetPatch({ exec: run, fromSha: a, toSha: b })).toMatchObject({ ok: false, different: true });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyHumanClearanceCarry, latestHumanClearance } from '../human-clearance-carry.mjs';
import { normalizeDiffFingerprint } from '../review-escalation.mjs';
import { restampAfterNumbering } from '../numbering-carry.mjs';
it('uses Git-generated diffs and stable patch ids to distinguish moved edits from safe offset rebases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-patch-read-only-'));
  const gitDiff = (before, after) => {
    writeFileSync(join(dir, 'a/auth.mjs'), before);
    writeFileSync(join(dir, 'b/auth.mjs'), after);
    let output;
    try {
      output = execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--', 'a/auth.mjs', 'b/auth.mjs'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (error.status !== 1) throw error;
      output = String(error.stdout);
    }
    return output.replaceAll('a/a/auth.mjs', 'a/auth.mjs').replaceAll('b/b/auth.mjs', 'b/auth.mjs');
  };
  const block = (name, allow = false) => `function ${name}() {\n  const user = currentUser();\n  const role = user.role;\n  audit(role);\n  return ${allow};\n  // shared padding one\n  // shared padding two\n  // shared padding three\n}\n\n`;
  const initial = block('testOnlyAuthorization') + block('productionAuthorization');
  const approved = block('testOnlyAuthorization', true) + block('productionAuthorization');
  const moved = block('testOnlyAuthorization') + block('productionAuthorization', true);
  try {
    mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
    const oldDiff = gitDiff(initial, approved), advancedBase = 'd'.repeat(40);
    for (const advance of [false, true]) {
      const prefix = advance ? '// upstream header\n' : '';
      for (const [next, allowed] of [[approved, true], [moved, false]]) {
        const headDiff = gitDiff(prefix + initial, prefix + next);
        const baseDelta = gitDiff(initial, prefix + initial), headDelta = gitDiff(approved, prefix + next);
        const patchId = input => execFileSync('git', ['patch-id', '--stable'], { cwd: dir, input, encoding: 'utf8' });
        expect(patchId(oldDiff)).toBe(patchId(headDiff));
        const run = (cmd, args, opts) => {
          if (args[0] === 'merge-base') return advance && args.includes(b) ? advancedBase : base;
          if (args[0] === 'diff' && args.includes(base) && args.includes(advancedBase)) return baseDelta;
          if (args[0] === 'diff' && args.includes(a) && args.includes(b)) return headDelta;
          if (args[0] === 'diff') return args.includes(a) ? oldDiff : headDiff;
          if (args[0] === 'patch-id') return patchId(opts.input);
          throw Error('unexpected git read');
        };
        expect(proveIdenticalNetPatch({ exec: run, fromSha: a, toSha: b }).ok).toBe(allowed);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it.each([
  ['indentation', 'if x:\n    pass\n    old()\n', 'if x:\n    pass\n        danger()\n', 'if x:\n    pass\n    danger()\n'],
  ['string whitespace', 'value = "old"\n', 'value = "a b"\n', 'value = "ab"\n'],
  ['trailing whitespace', 'value = "old"\n', 'value = "new" \n', 'value = "new"\n'],
  ['line endings', 'value = "old"\n', 'value = "new"\r\n', 'value = "new"\n'],
])('refuses a real whitespace-only %s change despite matching stable patch ids', (_name, initial, approved, changed) => {
  const dir = mkdtempSync(join(tmpdir(), 'net-patch-whitespace-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = text => { writeFileSync(join(dir, 'f.py'), text); git('add', 'f.py'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q', '-b', 'main'); const root = commit(initial);
    git('update-ref', 'refs/remotes/origin/main', root);
    git('checkout', '-qb', 'lane'); const from = commit(approved), to = commit(changed);
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir });
    const patchId = sha => exec('git', ['patch-id', '--stable'], { input: git('diff', root, sha), encoding: 'utf8' }).split(' ')[0];
    expect(patchId(from)).toBe(patchId(to));
    expect(proveIdenticalNetPatch({ exec, fromSha: from, toSha: to })).toMatchObject({ ok: false, different: true });
    const oldDiff = git('diff', root, from), headDiff = git('diff', root, to);
    for (const human of [false, true]) {
      const comments = [{ author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${from} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(oldDiff)} -->${human ? '\n<!-- cleared-human: chalbert -->' : ''}` }];
      const writes = [], state = { headRefOid: to, labels: ['review:pending'], comments };
      const writerExec = (cmd, args, opts) => cmd === 'git' ? exec(cmd, args, opts) : writes.push(args);
      const result = applyHumanClearanceCarry({ pr: 5463, repo: 'owner/repo', cwd: dir, exec: writerExec, log: () => {},
        evidence: { humanClearance: latestHumanClearance(comments), headSha: to, headDiffSha: to, headDiff },
        readLiveEvidence: () => ({ headSha: to, comments, reviews: [] }) });
      expect(result).toBeNull();
      const restamp = restampAfterNumbering({ repo: 'owner/repo', pr: human ? 5464 : 5463, cwd: dir, exec, state, reviews: [],
        guardReferrals: () => {}, readNetDiff: () => ({ scored: true, text: headDiff }),
        readLiveState: () => ({ state, reviews: [] }),
        provider: { postComment: (...args) => writes.push(args), setLabels: (...args) => writes.push(args) } });
      expect(restamp).toMatchObject({ action: 'refused' });
      expect(writes).toEqual([]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('real rebase: offset-only change carries human and automated acceptance through existing writers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-patch-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const content = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
  const commit = text => { writeFileSync(join(dir, 'f'), text); git('add', 'f'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q', '-b', 'main'); const root = commit(content);
    git('checkout', '-qb', 'lane'); const from = commit(content.replace('line 20', 'approved'));
    git('checkout', '-q', 'main'); commit('new main line\n' + content); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'replayed'); const to = commit('new main line\n' + content.replace('line 20', 'approved'));
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir });
    const proof = proveIdenticalNetPatch({ exec, fromSha: from, toSha: to });
    expect(proof.ok).toBe(true);
    const oldDiff = git('diff', root, from), headDiff = git('diff', 'origin/main', to);
    for (const human of [true, false]) {
      const original = { author: { login: 'chalbert' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${from} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(oldDiff)} -->${human ? '\n<!-- cleared-human: chalbert -->' : ''}` };
      const comments = [original], writes = [];
      const live = () => ({ headSha: to, comments, reviews: [] });
      if (human) {
        const result = applyHumanClearanceCarry({ pr: 5195, repo: 'owner/repo', cwd: dir, log: () => {},
          evidence: { humanClearance: latestHumanClearance(comments), headSha: to, headDiffSha: to, headDiff },
          readLiveEvidence: live, exec: (cmd, args, opts) => {
            if (cmd === 'git') return exec(cmd, args, opts);
            writes.push(args[args.indexOf('--body') + 1]); return '';
          } });
        expect(result?.carried).toMatchObject({ recorded: true, tier: 'net-patch', actor: 'chalbert' });
        expect(writes[0]).toContain('cleared-human: chalbert');
        const objection = { author: { login: 'chalbert' }, body: 'Do not land this.' };
        const held = applyHumanClearanceCarry({ pr: 5195, repo: 'owner/repo', cwd: dir, log: () => {},
          evidence: { humanClearance: latestHumanClearance(comments), headSha: to, headDiffSha: to, headDiff },
          exec, readLiveEvidence: () => ({ ...live(), comments: [...comments, objection] }) });
        expect(held?.action).toBe('defer');
      } else {
        const result = restampAfterNumbering({ repo: 'owner/repo', pr: 5195, cwd: dir, exec,
          state: { headRefOid: to, labels: ['review:pending'], comments }, reviews: [], guardReferrals: () => {},
          readNetDiff: () => ({ scored: true, text: headDiff }), readLiveState: () => ({ state: { headRefOid: to, labels: ['review:pending'], comments }, reviews: [] }),
          provider: { postComment: (_r, _p, body) => { writes.push(body); comments.push({ author: { login: 'chalbert' }, body }); }, setLabels: () => {} } });
        expect(result.action).toBe('restamped');
        expect(writes[0]).toContain(`reviewed-sha: ${to}`);
        expect(writes[0]).not.toContain('cleared-human:');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('refuses distinct non-UTF-8 source bytes that decode to the same replacement character', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-patch-encoding-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = bytes => { writeFileSync(join(dir, 'f.py'), bytes); git('add', 'f.py'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q', '-b', 'main'); const root = commit('# coding: latin-1\nvalue = "old"\n');
    git('update-ref', 'refs/remotes/origin/main', root);
    git('checkout', '-qb', 'lane');
    const from = commit(Buffer.from('# coding: latin-1\nvalue = "\xe9"\n', 'latin1'));
    const to = commit(Buffer.from('# coding: latin-1\nvalue = "\xea"\n', 'latin1'));
    const rawDiff = sha => execFileSync('git', ['diff', root, sha], { cwd: dir });
    expect(rawDiff(from).equals(rawDiff(to))).toBe(false);
    // Index hashes differ too; the changed-line bytes are what lossy decoding collapses.
    const added = bytes => bytes.toString('utf8').split('\n').filter(line => line.startsWith('+'));
    expect(added(rawDiff(from))).toEqual(added(rawDiff(to)));
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir });
    expect(proveIdenticalNetPatch({ exec, fromSha: from, toSha: to })).toMatchObject({ ok: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
