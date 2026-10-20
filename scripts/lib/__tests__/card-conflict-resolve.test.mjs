// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveRaisedByConflict, loadCardConflictSettings } from '../card-conflict-resolve.mjs';
import { defaultAttemptCardConflictRebase } from '../../conveyor/parked-pr-conflict-watch.mjs';
import { MISSING_RUN_CREDENTIAL_REFUSAL } from '../../conveyor/main-red-recovery.mjs';
import { rebaseDropManifest } from '../rebase-drop-manifest.mjs';

const legacyCardRebaseSettings = { value: { squashToSingleCommit: false }, sources: { squashToSingleCommit: 'tool' } };
const path = 'backlog/5360-parent.md';
const entry = n => `- Also raised by o/r#${n} (finding 1: \`we:backlog/xabc123-child.md:12\` — guard)`;
const card = entries => `---\nstatus: open\n---\n# Parent\n\nBody\n\n## Also raised by\n\n${entries.join('\n')}\n\n## Next\n\nUnchanged\n`;
const conflict = (left, right) => card([`<<<<<<< main\n${left.join('\n')}\n=======\n${right.join('\n')}\n>>>>>>> pr`]);
const resolve = (main, pr, extra = {}) => resolveRaisedByConflict({ path, main: card(main), pr: card(pr), merged: conflict(main, pr), ...extra });

describe('raised-by union refuses every other conflict', () => {
  it('unions two appended entries, main first, retaining following sections', () => {
    expect(resolve([entry(1)], [entry(2)])).toMatchObject({ ok: true, text: card([entry(1), entry(2)]) });
  });
  it('deduplicates in stable main order, then PR-only order, including multiline entries', () => {
    const multi = `${entry(3)}\n  - Nested requirement`;
    expect(resolve([entry(2), entry(1), multi], [multi, entry(4), entry(1)]).text)
      .toBe(card([entry(2), entry(1), multi, entry(4)]));
  });
  it('resolves JIT references before deduplicating', () => {
    const current = entry(1).replace('xabc123', '6000');
    expect(resolve([current], [entry(1)], { referenceMap: new Map([['xabc123', '6000']]) }).text).toBe(card([current]));
  });
  it('keeps a terminal list newline without creating a blank section', () => {
    const terminal = text => text.replace('\n## Next\n\nUnchanged\n', '');
    expect(resolve([entry(1)], [entry(2)], { main: terminal(card([entry(1)])), pr: terminal(card([entry(2)])),
      merged: terminal(conflict([entry(1)], [entry(2)])) }).text).toBe(terminal(card([entry(1), entry(2)])).trimEnd() + '\n');
  });
  it.each([
    { path: 'src/code.mjs' },
    { merged: conflict([entry(1)], [entry(2)]).replace('Body', '<<<<<<< main\nBody\n=======\nOther\n>>>>>>> pr') },
    { merged: conflict([entry(1)], [entry(2)]).replace('status: open', '<<<<<<< main\nstatus: open\n=======\nstatus: resolved\n>>>>>>> pr') },
    { merged: conflict([entry(1)], [entry(2)]).replace('## Also raised by', '## Design') },
    { main: card(['arbitrary prose']) },
  ])('refuses non-list/frontmatter/non-backlog conflicts: %j', extra => {
    expect(resolve([entry(1)], [entry(2)], extra)).toMatchObject({ ok: false, reason: expect.any(String) });
  });
  it('setting off refuses without resolving', () => {
    expect(resolve([entry(1)], [entry(2)], { enabled: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) });
  });
  it('settings use declared repo, platform, environment and standard with provenance', () => {
    const base = { env: {}, platform: {}, repo: {} };
    expect(loadCardConflictSettings(base)).toMatchObject({ value: { autoResolveRaisedBy: true }, sources: { autoResolveRaisedBy: 'standard' } });
    expect(loadCardConflictSettings({ ...base, platform: { autoResolveRaisedBy: false } })).toMatchObject({ value: { autoResolveRaisedBy: false }, sources: { autoResolveRaisedBy: 'platform' } });
    expect(loadCardConflictSettings({ ...base, platform: { autoResolveRaisedBy: false }, repo: { autoResolveRaisedBy: true } })).toMatchObject({ value: { autoResolveRaisedBy: true }, sources: { autoResolveRaisedBy: 'tool' } });
    expect(loadCardConflictSettings({ ...base, env: { WE_CARD_CONFLICTS_AUTO_RESOLVE_RAISED_BY: 'false' } })).toMatchObject({ value: { autoResolveRaisedBy: false }, sources: { autoResolveRaisedBy: 'env' } });
  });
});

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture({ code = false, outside = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'we-card-union-')); roots.push(root);
  const cwd = join(root, 'clone'); mkdirSync(cwd);
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { ...opts, cwd: opts.cwd ?? cwd,
    encoding: 'utf8', env: { ...process.env, ...opts.env, WE_COORDINATION_ROOT: join(root, 'claims'),
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
  const git = (...args) => { const r = run('git', args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  git('init', '--initial-branch=main'); mkdirSync(join(cwd, 'backlog'));
  writeFileSync(join(cwd, path), card([entry(0)])); git('add', '.'); git('commit', '-m', 'base');
  const common = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, path), card([entry(0), entry(1)]));
  writeFileSync(join(cwd, 'backlog/6000-child.md'), '---\nbornAs: xabc123\n---\n# Child\n');
  git('add', '.'); git('commit', '-m', 'main append'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-b', 'lane/cards', common);
  writeFileSync(join(cwd, path), card([entry(0), entry(2)]).replace('Body', outside ? 'Changed' : 'Body'));
  if (outside) { /* main must also change the same non-list hunk */ }
  if (code) writeFileSync(join(cwd, 'code.mjs'), 'export const x = 1;\n');
  git('add', '.'); git('commit', '-m', 'PR append');
  const head = git('rev-parse', 'HEAD');
  git('init', '--bare', join(root, 'remote.git')); git('remote', 'add', 'origin', join(root, 'remote.git'));
  git('push', 'origin', 'HEAD:refs/heads/lane/cards');
  const before = readFileSync(join(cwd, path), 'utf8');
  return { cwd, git, run, head, before };
}

describe('trusted no-checkout rebase path with real local Git', () => {
  it('resolves and publishes a fast-forward merge with current JIT refs and unchanged checkout', () => {
    const f = fixture();
    const result = rebaseDropManifest({ laneRef: 'lane/cards', cwd: f.cwd, run: f.run, fetch: false, cardRebaseSettings: legacyCardRebaseSettings });
    expect(result).toMatchObject({ action: 'rebased', resolvedRaisedBy: [path] });
    expect(f.git('show', `${result.newCommit}:${path}`) + '\n').toBe(card([entry(0), entry(1), entry(2)].map(e => e.replace('xabc123', '6000'))));
    expect(f.git('merge-base', '--is-ancestor', f.head, result.newCommit)).toBe('');
    expect(f.git('ls-remote', 'origin', 'refs/heads/lane/cards')).toContain(result.newCommit);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.head);
    expect(readFileSync(join(f.cwd, path), 'utf8')).toBe(f.before);
  });
  it('refuses a mixed code PR even when its only conflict is a list', () => {
    const f = fixture({ code: true });
    expect(rebaseDropManifest({ laneRef: 'lane/cards', cwd: f.cwd, run: f.run, fetch: false, cardRebaseSettings: legacyCardRebaseSettings }).action).toBe('skip');
    expect(f.git('ls-remote', 'origin', 'refs/heads/lane/cards')).toContain(f.head);
  });
  it('disabled policy leaves the conflicting remote head untouched', () => {
    const f = fixture();
    expect(rebaseDropManifest({ laneRef: 'lane/cards', cwd: f.cwd, run: f.run, fetch: false,
      cardConflictSettings: { value: { autoResolveRaisedBy: false }, sources: { autoResolveRaisedBy: 'tool' } } }).action).toBe('skip');
    expect(f.git('ls-remote', 'origin', 'refs/heads/lane/cards')).toContain(f.head);
  });
  it('pins and recomputes the card merge when another fetch advances main during the probe', () => {
    const f = fixture();
    f.git('checkout', 'main');
    writeFileSync(join(f.cwd, 'main-only.mjs'), 'export const preserved = true;\n');
    f.git('add', '.'); f.git('commit', '-m', 'main advanced elsewhere');
    const nextMain = f.git('rev-parse', 'HEAD');
    f.git('checkout', 'lane/cards');
    let advanced = false;
    const run = (cmd, args, opts) => {
      const result = f.run(cmd, args, opts);
      if (args[0] === 'merge-tree' && !advanced) {
        advanced = true;
        f.git('update-ref', 'refs/remotes/origin/main', nextMain);
      }
      return result;
    };
    const result = rebaseDropManifest({ laneRef: 'lane/cards', cwd: f.cwd, run, fetch: false, cardRebaseSettings: legacyCardRebaseSettings });
    expect(result.action).toBe('rebased');
    expect(f.git('show', `${result.newCommit}:main-only.mjs`)).toBe('export const preserved = true;');
  });
});

it('the card owner enforces credential refusal and a pinned Also-raised-by push', () => {
  const f = fixture();
  f.git('push', 'origin', 'refs/remotes/origin/main:refs/heads/main');
  const pr = { number: 42, headRefName: 'lane/cards', baseRefName: 'main', headRefOid: f.head };
  const pushes = [];
  const run = (cmd, args, opts) => {
    if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/web-everything/web-everything.git' };
    if (args.includes('push')) pushes.push({ args, opts });
    return f.run(cmd, args, opts);
  };
  const attempt = env => defaultAttemptCardConflictRebase({ pr, repo: 'web-everything/web-everything', cwd: f.cwd, run, env, readCache: () => null, cardRebaseSettings: legacyCardRebaseSettings });
  const refused = attempt({ GH_TOKEN: 'ghs_untrusted' });
  expect(refused).toMatchObject({ ok: false, action: 'error', error: MISSING_RUN_CREDENTIAL_REFUSAL });
  expect(pushes).toEqual([]);
  expect(f.git('ls-remote', 'origin', 'refs/heads/lane/cards')).toContain(f.head);
  const result = attempt({ GH_TOKEN: 'ghp_test' });
  expect(result).toMatchObject({ action: 'rebased', resolvedRaisedBy: [path] });
  expect(pushes).toHaveLength(1);
  expect(pushes[0].opts).toMatchObject({ inheritEnv: false, env: { WE_CI_PUSH_TOKEN: 'ghp_test', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  expect(f.git('show', `${result.newCommit}:${path}`)).toContain(entry(2).replace('xabc123', '6000'));
  expect(f.git('ls-remote', 'origin', 'refs/heads/lane/cards')).toContain(result.newCommit);
});
