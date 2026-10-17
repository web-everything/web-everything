import { it, expect } from 'vitest';
import { proveIdenticalNetPatch, resolveIdenticalNetPatchSetting } from '../identical-net-patch.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40), base = 'c'.repeat(40);
const exec = (different = false) => (cmd, args, opts) => {
  if (args[0] === 'merge-base') return base;
  if (args[0] === 'diff') return args.includes(a) ? 'old diff' : 'new diff';
  if (args[0] === 'patch-id') return `${different && opts.input === 'new diff' ? b : a} ${base}\n`;
  throw Error('unexpected git');
};
it('carries offset-only net patches using git stable patch ids', () => {
  expect(proveIdenticalNetPatch({ exec: exec(), fromSha: a, toSha: b })).toMatchObject({ ok: true, tier: 'net-patch' });
});
it('refuses any different patch id and unreadable or empty evidence', () => {
  expect(proveIdenticalNetPatch({ exec: exec(true), fromSha: a, toSha: b }).ok).toBe(false);
  for (const run of [() => '', () => { throw Error('unreadable'); }]) expect(proveIdenticalNetPatch({ exec: run, fromSha: a, toSha: b }).ok).toBe(false);
});
it('defaults on and preserves settings provenance and off switch', () => {
  expect(resolveIdenticalNetPatchSetting({ env: {}, tool: {}, platform: {} })).toMatchObject({ value: true, source: 'standard' });
  expect(resolveIdenticalNetPatchSetting({ env: { WE_REVIEW_CARRY_ACROSS_IDENTICAL_NET_PATCH: 'false' }, tool: {}, platform: {} })).toMatchObject({ value: false, source: 'env' });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyHumanClearanceCarry, latestHumanClearance } from '../human-clearance-carry.mjs';
import { normalizeDiffFingerprint } from '../review-escalation.mjs';
import { restampAfterNumbering } from '../numbering-carry.mjs';
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
