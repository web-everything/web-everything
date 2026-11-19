/** @file Real Git resolution and filesystem persistence for audit IO. */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createAuditDeps } from '../codex-audit-io.mjs';
import { main, QUESTION_HASH } from '../codex-audit.mjs';

describe('codex-audit real IO', () => {
  it('resolves a branch and commit SHA to the full 40-hex commit in a real repo', async () => {
    await withRealRepo(async ({ root: repo, tmp, git, head, commit }) => {
      const sha = head();
      git(['branch', 'audit-target', sha]);
      commit({ 'next.txt': 'another commit\n' });
      const deps = createAuditDeps({ cwd: repo, home: join(tmp, 'home') });

      expect(head()).not.toBe(sha);
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(deps.resolveSha('audit-target')).toBe(sha);
      expect(deps.resolveSha(sha)).toBe(sha);
    });
  });

  it('reviews unrestricted real Git delta including reverted guards, renames and <material>.mjs with base at head', async () => {
    await withRealRepo(async ({ root: repo, tmp, git, head, commit }) => {
      commit({ 'guard.mjs': 'base guard\n', 'test.mjs': 'guard test\n' });
      const base = head();
      commit({ 'guard.mjs': 'improved guard\n' });
      const prior = head();
      commit({ 'guard.mjs': 'base guard\n', '<material>.mjs': 'new unchecked path\n' });
      git(['mv', 'test.mjs', 'relocated.mjs']);
      git(['commit', '--quiet', '-m', 'relocate guard test']);
      const current = head();
      git(['update-ref', 'refs/remotes/origin/lane/audit', current]);
      git(['update-ref', 'refs/remotes/origin/main', current]);
      git(['remote', 'add', 'origin', repo]);
      git(['config', 'core.bigFileThreshold', '1']);
      writeFileSync(join(repo, '.git/info/attributes'), '* binary\n');
      const deps = createAuditDeps({ cwd: repo, home: join(tmp, 'home') });
      expect(deps.refsPointingAt(current)).toContain('lane/audit');
      expect(deps.isAncestor(prior, current)).toBe(true);
      expect(deps.isAncestor(current, prior)).toBe(false);
      let reviewed = false;
      const code = await main([`--base=${current}`, `--head=${current}`, '--ref=lane/audit', '--converge'], {
        ...deps,
        readRecords: () => [{ at: '2026-11-17T00:00:00Z', base, head: prior, ref: 'lane/audit',
          questionHash: QUESTION_HASH, verdict: 'WEAKENED', findings: ['guard.mjs:1 gap'] }],
        now: () => '2026-11-18T00:00:00Z', appendRecord: () => {}, stdout: () => {}, stderr: () => {},
        runCodex: prompt => {
          const command = prompt.split('\n').find(line => line.startsWith('git --no-replace-objects diff '));
          expect(command).toBe(`git --no-replace-objects diff --no-relative --no-ext-diff --no-textconv --ignore-submodules=none --text --no-renames ${prior} ${current}`);
          const delta = String(git(command.split(' ').slice(1)));
          expect(delta).toContain('<material>.mjs');
          expect(delta).toContain('-improved guard');
          expect(delta).toContain('deleted file mode');
          expect(delta).toContain('+++ b/relocated.mjs');
          reviewed = true;
          return 'NOT WEAKENED\nFIXED: guard.mjs:1 gap';
        },
      });
      expect(code).toBe(0);
      expect(reviewed).toBe(true);
    });
  });

  it('runs auditor Git from a subdirectory without relative narrowing, replacements or grafts', async () => {
    await withRealRepo(async ({ root: repo, tmp, git, head, commit }) => {
      commit({ 'scripts/marker.txt': 'marker\n', 'outside.txt': 'before\n' });
      const base = head();
      commit({ 'outside.txt': 'after\n' });
      const current = head();
      git(['config', 'diff.relative', 'true']);
      git(['replace', current, base]);
      const cwd = join(repo, 'scripts');
      const args = ['--no-replace-objects', 'diff', '--no-relative', '--no-ext-diff',
        '--no-textconv', '--ignore-submodules=none', '--text', `${base}...${current}`];
      let scratch;
      const deps = createAuditDeps({ cwd, scratchRoot: tmp, spawnSync: (command, argv, options) => {
        if (command === 'git') return spawnSync(command, argv, options);
        expect(command).toBe(process.execPath);
        scratch = dirname(options.env.GIT_INDEX_FILE);
        expect(options.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
        expect(options.env.GIT_GRAFT_FILE).toBe(join(scratch, 'no-grafts'));
        expect(existsSync(options.env.GIT_GRAFT_FILE)).toBe(false);
        const delta = spawnSync('git', args, options);
        expect(delta.status).toBe(0);
        expect(delta.stdout).toContain('diff --git a/outside.txt b/outside.txt');
        expect(delta.stdout).toContain('+after');
        return { status: 0, stdout: JSON.stringify({ exitCode: 0, timedOut: false, lastMessage: 'NOT WEAKENED' }) };
      } });
      expect(deps.runCodex('replacement probe')).toBe('NOT WEAKENED');
      expect(existsSync(scratch)).toBe(false);
      git(['replace', '-d', current]);
      writeFileSync(join(repo, '.git/info/grafts'), `${base} ${current}\n`);
      expect(deps.runCodex('graft probe')).toBe('NOT WEAKENED');
      expect(existsSync(scratch)).toBe(false);
    });
  });

  it('refuses real Git backward and unrelated bases before review', async () => {
    await withRealRepo(async ({ root: repo, tmp, git, head, commit }) => {
      const oldBase = head();
      commit({ 'base.txt': 'base\n' });
      const base = head();
      commit({ 'anchor.txt': 'anchor\n' });
      const prior = head();
      commit({ 'delta.txt': 'delta\n' });
      const current = head();
      git(['checkout', '--quiet', '--detach', oldBase]);
      commit({ 'other.txt': 'other\n' });
      const unrelated = head();
      git(['update-ref', 'refs/remotes/origin/main', base]);
      git(['update-ref', 'refs/heads/main', base]);
      git(['remote', 'add', 'origin', repo]);
      const deps = createAuditDeps({ cwd: repo, home: join(tmp, 'home') });
      const errors = [];
      const overrides = { ...deps, now: () => '2026-11-18T00:00:00Z',
        readRecords: () => [{ at: '2026-11-17T00:00:00Z', base, head: prior, ref: 'lane/audit',
          questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', findings: [] }],
        runCodex: () => { throw new Error('must refuse before review'); },
        stderr: text => errors.push(text), stdout: () => {},
      };
      expect(await main([`--base=${oldBase}`, `--head=${current}`, '--ref=lane/audit', '--converge'], overrides)).toBe(2);
      expect(await main([`--base=${unrelated}`, `--head=${current}`, '--ref=lane/audit', '--converge'], overrides)).toBe(2);
      expect(errors).toHaveLength(2);
      expect(errors.every(text => text.includes('run a full audit'))).toBe(true);
    });
  });

  it('refuses real Git B→A then C→D despite local origin/main at branch head', async () => {
    await withRealRepo(async ({ root: repo, tmp, git, head, commit }) => {
      const b = head();
      git(['update-ref', 'refs/remotes/origin/main', b]);
      commit({ 'a.txt': 'audited change\n' });
      const a = head();
      commit({ 'gap.txt': 'unreviewed guard removal\n' });
      const c = head();
      commit({ 'd.txt': 'later audited change\n' });
      const d = head();
      commit({ 'h.txt': 'delta\n' });
      const h = head();
      git(['checkout', '--quiet', '--detach', h]);
      git(['update-ref', 'refs/heads/main', b]);
      git(['update-ref', 'refs/remotes/origin/main', h]);
      git(['remote', 'add', 'origin', repo]);
      const deps = createAuditDeps({ cwd: repo, home: join(tmp, 'home') });
      const errors = [];
      let reviews = 0;
      const overrides = { ...deps, now: () => '2026-11-18T00:00:00Z',
        readRecords: () => [[b, a], [c, d]].map(([base, head]) => ({
          at: '2026-11-17T00:00:00Z', base, head, ref: 'lane/audit',
          questionHash: QUESTION_HASH, verdict: 'NOT WEAKENED', findings: [],
        })),
        runCodex: () => { reviews++; return 'NOT WEAKENED'; },
        stderr: text => errors.push(text), stdout: () => {},
      };
      expect(await main([`--base=${b}`, `--head=${h}`, '--ref=lane/audit', '--converge'], overrides)).toBe(2);
      expect(await main([`--base=${d}`, `--head=${h}`, '--ref=lane/audit', '--converge'], overrides)).toBe(2);
      expect(reviews).toBe(0);
      expect(errors).toEqual(Array(2).fill('converge needs a main-line base covered by the last full audit; run a full audit\n'));
    });
  });

  it('ignores replace refs and grafts that fake ancestry in real Git', async () => {
    await withRealRepo(async ({ root: repo, tmp, git, head, commit }) => {
      const base = head();
      commit({ 'prior.txt': 'prior\n' }); const prior = head();
      git(['checkout', '--quiet', '--detach', base]);
      commit({ 'other.txt': 'other\n' }); const other = head();
      const deps = createAuditDeps({ cwd: repo, scratchRoot: tmp });
      expect(deps.isAncestor(prior, other)).toBe(false);
      git(['replace', '--graft', other, prior]);
      expect(spawnSync('git', ['merge-base', '--is-ancestor', prior, other], { cwd: repo }).status).toBe(0);
      expect(deps.isAncestor(prior, other)).toBe(false);
      git(['replace', '-d', other]);
      writeFileSync(join(repo, '.git/info/grafts'), `${other} ${prior}\n`);
      expect(spawnSync('git', ['merge-base', '--is-ancestor', prior, other], { cwd: repo }).status).toBe(0);
      expect(deps.isAncestor(prior, other)).toBe(false);
      expect(deps.isShallow()).toBe(false);
      writeFileSync(join(repo, '.git/shallow'), `${other}\n`);
      expect(deps.isShallow()).toBe(true);
    });
  });

  it('throws for an unknown ref in a real repo', async () => {
    await withRealRepo(async ({ root: repo, tmp }) => {
      const deps = createAuditDeps({ cwd: repo, home: join(tmp, 'home') });

      expect(() => deps.resolveSha('missing-audit-ref'))
        .toThrow('audit subprocess failed or exceeded its bound');
    });
  });

  it('creates directories under the temp home and appends JSON lines at the default record path', async () => {
    await withRealRepo(async ({ root: repo, tmp, head }) => {
      const home = join(tmp, 'home');
      const recordPath = join(home, 'workspace', '.operations', 'coordination', 'audits.jsonl');
      // Native Node keeps the adapter's settings URL intact; Vite rewrites new URL(..., import.meta.url).
      const moduleUrl = new NodeURL('../codex-audit-io.mjs', import.meta.url).href;
      const appendRecord = record => execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { createAuditDeps } = await import(process.argv[1]);
        const deps = createAuditDeps({ cwd: process.argv[2], home: process.argv[3] });
        deps.appendRecord(JSON.parse(process.argv[4]));
      `, moduleUrl, repo, home, JSON.stringify(record)], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
      const first = { sha: head(), ok: true, message: 'first audit\nwith a newline' };
      const second = { sha: head(), ok: false, message: 'second audit' };

      expect(existsSync(home)).toBe(false);
      appendRecord(first);
      expect(existsSync(dirname(recordPath))).toBe(true);
      expect(readFileSync(recordPath, 'utf8')).toBe(`${JSON.stringify(first)}\n`);

      appendRecord(second);
      const contents = readFileSync(recordPath, 'utf8');
      expect(contents).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
      expect(contents.trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([first, second]);
    });
  });
});
