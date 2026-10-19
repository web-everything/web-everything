// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { proveCardUnionOnly, resolveCardUnionCarrySetting, tryCardUnionCarry, restampCardUnion } from '../card-union-carry.mjs';

beforeEach(() => vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'on'));
afterEach(() => vi.unstubAllEnvs());
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const path = 'backlog/1-card.md';
const entry = n => `- Also raised by o/r#${n} (finding)`;
const card = list => `---\nstatus: open\n---\n# Card\n\nBody\n\n## Also raised by\n\n${list.join('\n')}\n\n## Next\n\nTail\n`;
function fixture({ accepted = card([entry(0), entry(1)]), current = card([entry(0), entry(1), entry(2)]), main = card([entry(0), entry(2)]), extra, executable = false, newCard = false, ambiguous = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'we-card-carry-')); roots.push(cwd);
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { ...opts, cwd, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
  const git = (...args) => { const r = run('git', args); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  const write = (file, text) => writeFileSync(join(cwd, file), text);
  git('init', '--initial-branch=main'); mkdirSync(join(cwd, 'backlog'));
  if (!newCard) write(path, card([entry(0)]));
  write('backlog/99-child.md', '---\nbornAs: xabc123\n---\n# Child\n');
  if (ambiguous) write('backlog/98-child.md', '---\nbornAs: xabc123\n---\n# Duplicate\n');
  git('add', '.'); git('commit', '-m', 'base'); const common = git('rev-parse', 'HEAD');
  write(path, accepted); if (extra) write(extra, 'same\n');
  git('add', '.'); git('commit', '-m', 'accepted'); const acceptedHead = git('rev-parse', 'HEAD');
  git('checkout', 'main'); git('reset', '--hard', common);
  if (!newCard) write(path, main);
  git('add', '.'); git('commit', '--allow-empty', '-m', 'main list');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-b', 'lane/new'); write(path, current); if (extra) write(extra, 'same\n');
  if (executable) chmodSync(join(cwd, path), 0o755);
  git('add', '.'); git('commit', '-m', 'union'); const newHead = git('rev-parse', 'HEAD');
  return { cwd, run, acceptedHead, newHead, mainRef: 'origin/main' };
}

describe('card union git proof', () => {
  it('drops main contributions from each net patch and permits union children', () => {
    const child = `${entry(1)}\n  detail`;
    expect(proveCardUnionOnly(fixture({ accepted: card([entry(0), child]), current: card([entry(0), entry(2), child]) }))).toMatchObject({ ok: true });
  });
  it('normalizes hash references with the resolver visitor', () => {
    const before = `${entry(1)}\n  see o/r#xabc123 and we:backlog/xabc123-child.md`;
    const after = `${entry(1)}\n  see o/r#99 and we:backlog/99-child.md`;
    expect(proveCardUnionOnly(fixture({ accepted: card([entry(0), before]), current: card([entry(0), entry(2), after]) }))).toMatchObject({ ok: true });
  });
  it('refuses an ambiguous referenced hash mapping', () => {
    const text = `${entry(1)}\n  see o/r#xabc123`;
    expect(proveCardUnionOnly(fixture({ ambiguous: true, accepted: card([entry(0), text]), current: card([entry(0), entry(2), text]) }))).toMatchObject({ ok: false, reason: 'ambiguous JIT reference mapping' });
  });
  it.each([
    ['extra prose', { current: card([entry(0), entry(1), entry(2)]).replace('Tail', 'Other') }],
    ['non-card', { extra: 'code.mjs' }],
    ['removed prose', { accepted: card([entry(0), entry(1)]).replace('Body\n', ''), current: card([entry(0), entry(1), entry(2)]).replace('Body\n', '') }],
    ['second section', { current: card([entry(0), entry(1), entry(2)]) + '\n## Also raised by\n' + entry(3) }],
    ['new card', { newCard: true }],
    ['executable blob', { executable: true }],
    ['dropped accepted entry', { current: card([entry(0), entry(2), entry(3)]) }],
  ])('refuses %s', (_, options) => expect(proveCardUnionOnly(fixture(options)).ok).toBe(false));
  it('refuses the same added prose lines reordered outside list entries', () => {
    const accepted = card([entry(0), entry(1)]).replace('Body\n', 'Body\nFirst accepted line\nSecond accepted line\n');
    const current = card([entry(0), entry(1), entry(2)]).replace('Body\n', 'Body\nSecond accepted line\nFirst accepted line\n');
    expect(proveCardUnionOnly(fixture({ accepted, current }))).toMatchObject({
      ok: false, reason: `${path}: changes outside the Also raised by list differ between accepted and new head`,
    });
  });
  it('refuses identical prose relocated under a different heading', () => {
    const accepted = card([entry(0), entry(1)]).replace('Body\n', 'Body\nAccepted prose\n');
    const current = card([entry(0), entry(1), entry(2)]).replace('Tail\n', 'Tail\nAccepted prose\n');
    expect(proveCardUnionOnly(fixture({ accepted, current }))).toMatchObject({
      ok: false, reason: `${path}: changes outside the Also raised by list differ between accepted and new head`,
    });
  });
  it('refuses changed frontmatter outside the list', () => {
    const current = card([entry(0), entry(1), entry(2)]).replace('status: open', 'status: done');
    expect(proveCardUnionOnly(fixture({ current }))).toMatchObject({
      ok: false, reason: `${path}: changes outside the Also raised by list differ between accepted and new head`,
    });
  });
  it('permits pure list union when advancing main changes prose and shifts the list', () => {
    // The accepted base has Body; the new base inherits main's expanded prose.
    const mainProse = text => text.replace('Body\n', 'Updated on main\nAnother main line\n');
    expect(proveCardUnionOnly(fixture({
      main: mainProse(card([entry(0), entry(2)])),
      current: mainProse(card([entry(0), entry(1), entry(2)])),
    }))).toMatchObject({ ok: true });
  });
  it('preserves prose added under the same heading', () => {
    const accepted = card([entry(0), entry(1)]).replace('Body\n', 'Body\nAccepted prose\n');
    const current = card([entry(0), entry(1), entry(2)]).replace('Body\n', 'Body\nAccepted prose\n');
    expect(proveCardUnionOnly(fixture({ accepted, current })).ok).toBe(true);
  });
  it('permits entries contributed by fresh main with the same reference normalization', () => {
    const mainEntry = `${entry(2)}\n  see o/r#xabc123`;
    const normalized = `${entry(2)}\n  see o/r#99`;
    expect(proveCardUnionOnly(fixture({
      main: card([entry(0), mainEntry]), current: card([entry(0), entry(1), normalized]),
    })).ok).toBe(true);
  });
  it('refuses an entry invented by the new head', () => {
    expect(proveCardUnionOnly(fixture({ current: card([entry(0), entry(1), entry(2), entry(3)]) }))).toMatchObject({
      ok: false, reason: `${path}: entry not from accepted head or main`,
    });
  });
  it('fails closed on unreadable git', () => expect(proveCardUnionOnly({ acceptedHead: 'a'.repeat(40), newHead: 'b'.repeat(40), run: () => ({ status: 1 }) })).toMatchObject({ ok: false, reason: 'unreadable git rev-parse' }));
});

describe('card union policy', () => {
  const base = { env: {}, platform: {}, repo: {} };
  it('defaults true and exposes each cascade source', () => {
    expect(resolveCardUnionCarrySetting(base)).toEqual({ value: true, source: 'standard' });
    expect(resolveCardUnionCarrySetting({ ...base, platform: { carryAcceptanceOnUnion: false } })).toEqual({ value: false, source: 'platform' });
    expect(resolveCardUnionCarrySetting({ ...base, repo: { carryAcceptanceOnUnion: false } })).toEqual({ value: false, source: 'tool' });
    expect(resolveCardUnionCarrySetting({ ...base, env: { WE_CARD_CONFLICTS_CARRY_ACCEPTANCE_ON_UNION: 'false' } })).toEqual({ value: false, source: 'env' });
  });
  it('uses only the sanctioned new-head restamp (expect-head forbids new-head)', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(restampCardUnion({ repo: 'o/r', pr: 1, acceptedHead: 'a'.repeat(40), newHead: 'b'.repeat(40), spawn }).ok).toBe(true);
    expect(spawn.mock.calls[0][1]).toContain('--to=restamp');
    expect(spawn.mock.calls[0][1]).toContain(`--new-head=${'b'.repeat(40)}`);
  });
  it.each(['off', 'on'])('requires both carry settings (global %s)', global => {
    vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', global);
    const prove = vi.fn(() => ({ ok: true })); const restamp = vi.fn(() => ({ ok: true }));
    const input = { labels: ['review:accepted'],
      comments: [{ author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${'a'.repeat(40)} -->` }],
      newHead: 'b'.repeat(40), prove, restamp, setting: { value: true } };
    const result = tryCardUnionCarry(input);
    expect(result.ok).toBe(global === 'on');
    if (global === 'off') {
      expect(result.reason).toMatch(/carryAcceptanceOnUnion.*acceptCarryForward/);
      expect(prove).not.toHaveBeenCalled(); expect(restamp).not.toHaveBeenCalled();
    } else { expect(prove).toHaveBeenCalledOnce(); expect(restamp).toHaveBeenCalledOnce(); }
  });
  it('never restamps without a trusted acceptance', () => {
    const restamp = vi.fn();
    expect(tryCardUnionCarry({ labels: ['review:accepted'], comments: [{ author: { login: 'stranger' }, body: `<!-- reviewed-sha: ${'a'.repeat(40)} -->` }], restamp, setting: { value: true } }).ok).toBe(false);
    expect(restamp).not.toHaveBeenCalled();
  });
});
