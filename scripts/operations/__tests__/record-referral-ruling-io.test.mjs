import { describe, it, expect, vi } from 'vitest';
import { cardRepo } from './helpers/card-ruling-repo.mjs';
import * as ruling from '../ruling-card-branch.mjs';
import { landRulingCard } from '../record-referral-ruling-io.mjs';
import { landPreventionCard } from '../land-prevention-card.mjs';
import { createFileItemSinks, createRulingCardBranchSink } from '../file-item-io.mjs';
import { FILE_ITEM_CARD_BRANCH_EFFECT, planFileItem } from '../file-item.mjs';
import { buildRulingCardInput } from '../record-referral-ruling.mjs';
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { SCAFFOLD_EFFECT } from '../scaffold.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { prepVerdict } from '../../lib/prep-block.mjs';
import { planDedupe, cardFromText } from '../../lib/card-dedupe.mjs';

const key = 'referral-run-123:' + 'a'.repeat(64);
const rel = 'backlog/101-ruling.md';
const digest = '1. `we:scripts/a.mjs:7` — Finding';
const content = `---\nstatus: open\nrulingKey: "${key}"\n---\n# Ruling\n\n${digest}\n`;
const input = { title: 'Ruling', kind: 'story', size: '2', digest, scope: 'we:scripts/a.mjs',
  queue: 'true', session: 'card-ruling-test', rulingKey: key };
const clean = () => ({ action: 'file', matches: [] });
const noDelete = () => { throw new Error('filed cards must never be deleted or salvaged'); };

function io(r) {
  const calls = [], prs = new Map(); let failOpen = false, filings = 0;
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'git') return r.git(...(args[0] === '-C' ? args.slice(2) : args));
    if (cmd === 'gh') return '';
    if (args.includes('acquire')) return JSON.stringify({ lane: 1, path: r.root, holder: 'test' });
    if (args.includes('release')) return '';
    if (args.includes('file-item')) {
      filings++;
      const passedKey = args.find(a => a.startsWith('--rulingKey='))?.slice(12);
      expect(passedKey).toBe(key);
      r.put(rel, content); r.git('add', rel);
      const commit = r.commit();
      r.git('update-ref', `refs/heads/${ruling.rulingBranch(key)}`, commit);
      return JSON.stringify({ verdict: { num: 101, rel } });
    }
    if (args.includes('verify')) return JSON.stringify({ verdict: { ok: true } });
    if (args.includes('open-pr')) {
      if (failOpen) throw new Error('crash before open-pr');
      const ref = args.find(a => a.startsWith('--ref='))?.slice(6);
      expect(ref).toBe(ruling.rulingBranch(key));
      if (!prs.has(ref)) prs.set(ref, 77);
      return JSON.stringify({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: prs.get(ref), url: 'https://example.test/77' } }] } } });
    }
    throw new Error('unexpected child');
  };
  const lookup = k => ruling.lookupRulingCard({ root: r.root, rulingKey: k, git: (...args) => {
    if (args[0] === 'ls-remote') return ''; // authoritative empty origin, no network
    return r.git(...args);
  } });
  return { exec, lookup, calls, prs, get filings() { return filings; }, crash: value => { failOpen = value; } };
}

describe('per-ruling branch ownership and crash recovery', () => {
  it('finding 7: keyed branches still require strict dedupe, full finding coverage and open status', async () => {
    const r = cardRepo();
    try {
      r.put(rel, content); let sha = r.commit();
      const ref = `refs/heads/${ruling.rulingBranch(key)}`;
      r.git('update-ref', ref, sha);
      for (const plan of ['unreadable', null, { action: 'off', matches: [] }, { action: 'partial', matches: [] },
        { action: 'mention', matches: [{ card: { rel: 'backlog/999-other.md', host: 'main' } }] }]) {
        const dedupe = vi.fn(() => { if (plan === 'unreadable') throw new Error('lookup failed'); return plan; });
        const land = vi.fn();
        const result = await landRulingCard(input, { dedupe, lookupRulingCard: io(r).lookup, landPreventionCard: land });
        expect(result, JSON.stringify(plan)).toMatchObject({ ok: false, step: 'dedupe' });
        expect(dedupe).toHaveBeenCalledOnce(); expect(land).not.toHaveBeenCalled();
      }
      const own = cardFromText({ rel, text: content, host: 'main' });
      const dedupe = vi.fn(() => planDedupe({ input, cards: [own], policy: { dedupe: true, similarity: 0.3 } }));
      const land = vi.fn(async () => ({ ok: true, step: 'done', rel, pr: 77, reused: true }));
      expect(await landRulingCard(input, { dedupe, lookupRulingCard: io(r).lookup, landPreventionCard: land }))
        .toMatchObject({ ok: true, reused: true, ref: `we:${rel}@pr77` });
      expect(dedupe).toHaveBeenCalledOnce(); expect(land).toHaveBeenCalledOnce();
      for (const bytes of [content.replace('status: open', 'status: closed'), content.replace(' — Finding', ' — Different finding')]) {
        r.put(rel, bytes); sha = r.commit(); r.git('update-ref', ref, sha);
        const land = vi.fn();
        const result = await landRulingCard(input, { dedupe: clean, lookupRulingCard: io(r).lookup, landPreventionCard: land });
        expect(result).toMatchObject({ ok: false }); expect(land).not.toHaveBeenCalled();
        expect(ruling.lookupRulingCard({ root: r.root, rulingKey: key, digest: input.digest, git: (...args) => r.git(...args) }))
          .toMatchObject({ ok: false });
      }
    } finally { r.close(); }
  });
  it('finding 4: ruling PRs receive review:pending before lane release', async () => {
    const r = cardRepo();
    try {
      const h = io(r);
      expect(await landRulingCard(input, { dedupe: clean, lookupRulingCard: h.lookup, exec: h.exec,
        write: () => {}, removeCards: noDelete, salvageCards: noDelete })).toMatchObject({ ok: true });
      const label = h.calls.findIndex(([cmd, args]) => cmd === 'gh' && args.includes('review:pending'));
      const release = h.calls.findIndex(([, args]) => args.includes('release'));
      expect(label).toBeGreaterThan(-1);
      expect(h.calls[label][1]).toEqual(['pr', 'edit', '77', '--repo', 'web-everything/web-everything', '--add-label', 'review:pending']);
      expect(release).toBeGreaterThan(label);
    } finally { r.close(); }
  });
  it('unreadable ruling-key lookup fails closed and files nothing', async () => {
    const land = vi.fn();
    const result = await landRulingCard(input, { dedupe: clean, lookupRulingCard: () => { throw new Error('unreadable'); }, landPreventionCard: land });
    expect(result).toMatchObject({ ok: false, step: 'ruling-lookup' });
    expect(result.reason).toContain('nothing filed'); expect(land).not.toHaveBeenCalled();
  });
  it('oversized ruling identity stops with a re-preparation report and no filing', async () => {
    const land = vi.fn(), lookup = vi.fn();
    const result = await landRulingCard({ ...input, rulingKey: `${'x'.repeat(161)}:${'a'.repeat(64)}` },
      { dedupe: clean, lookupRulingCard: lookup, landPreventionCard: land });
    expect(result.ok).toBe(false); expect(result.reason).toContain('re-prepare');
    expect(land).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
  });
  it('missing persisted ruling identity stops without silently minting a new key', async () => {
    const land = vi.fn();
    expect(await landRulingCard({ ...input, rulingKey: undefined }, { dedupe: clean, landPreventionCard: land })).toMatchObject({ ok: false });
    expect(land).not.toHaveBeenCalled();
  });
  it('the legacy batch-branch card stops with a report', async () => {
    const r = cardRepo();
    try {
      r.put(rel, content); r.commit(); r.git('branch', 'lane/card-batch-2026-11-26');
      const h = io(r), land = vi.fn();
      const result = await landRulingCard(input, { dedupe: clean, lookupRulingCard: h.lookup, landPreventionCard: land });
      expect(result).toMatchObject({ ok: false, step: 'ruling-lookup' });
      expect(result.reason).toMatch(/legacy.*batch/i); expect(land).not.toHaveBeenCalled();
      expect(r.git('show', `lane/card-batch-2026-11-26:${rel}`)).toBe(content);
    } finally { r.close(); }
  });
  it('resume after a crash between file-item and open-pr reuses the filed card and opens exactly one PR', async () => {
    const r = cardRepo();
    try {
      const h = io(r); h.crash(true);
      const options = { dedupe: clean, lookupRulingCard: h.lookup, exec: h.exec, write: () => {},
        removeCards: noDelete, salvageCards: noDelete };
      expect(await landRulingCard(input, options)).toMatchObject({ ok: false, step: 'open-pr' });
      expect(h.filings).toBe(1); expect(h.prs.size).toBe(0);
      expect(h.calls.some(([, args]) => args.includes('release'))).toBe(false);
      h.crash(false);
      const result = await landRulingCard(input, options);
      expect(result).toMatchObject({ ok: true, reused: true, ref: `we:${rel}@pr77` });
      expect(await landRulingCard(input, options)).toMatchObject({ ok: true, ref: `we:${rel}@pr77` });
      expect(h.filings).toBe(1); expect(h.prs.size).toBe(1);
      expect(r.git('show', `${ruling.rulingBranch(key)}:${rel}`)).toBe(content);
      expect(r.git('for-each-ref', '--format=%(refname)', 'refs/heads/lane/card-batch-')).toBe('');
    } finally { r.close(); }
  });
  it('a preserved local-only ruling branch is imported into the acquired lane without refiling', async () => {
    const r = cardRepo();
    try {
      r.put(rel, content); const sha = r.commit(), branch = ruling.rulingBranch(key), calls = [];
      const result = await ruling.landRulingInLane(input, { lane: r.root, sourceRoot: `${r.root}-source`, laneRunMjs: 'run.mjs',
        lookup: () => ({ ok: true, card: { rel, sha, branch } }), parse: JSON.parse, submit: value => value,
        scratchFile: () => join(r.root, 'body.md'), writeFile: () => {},
        exec: (cmd, args) => {
          calls.push([cmd, args]);
          if (args.includes('file-item')) throw new Error('duplicate filing');
          if (args.includes('cat-file')) throw new Error('not present in acquired lane');
          if (args.includes('fetch')) return '';
          if (args.includes('rev-parse')) return sha;
          if (args.includes('verify')) return '{"verdict":{"ok":true}}';
          if (args.includes('open-pr')) return '{"outcome":"opened","pr":77}';
          if (cmd === 'git') return r.git(...args.slice(2));
          throw new Error('unexpected child');
        } });
      expect(result).toMatchObject({ ok: true, reused: true, pr: 77 });
      expect(calls.find(([, args]) => args.includes('fetch'))[1].slice(-2)).toEqual([`${r.root}-source`, sha]);
      expect(calls.some(([, args]) => args.includes('file-item'))).toBe(false);
    } finally { r.close(); }
  });
  it('ruling cards never reach the shared batch branch', async () => {
    const r = cardRepo();
    try {
      const shared = vi.fn(), own = vi.fn(async () => ({ pushed: true }));
      const sinks = createFileItemSinks({ root: r.root, cardBranch: shared, rulingCardBranch: own });
      await sinks[FILE_ITEM_CARD_BRANCH_EFFECT]({ rel, content, rulingKey: key });
      expect(shared).not.toHaveBeenCalled(); expect(own).toHaveBeenCalledOnce();
      await sinks[FILE_ITEM_CARD_BRANCH_EFFECT]({ rel, content, batchDate: '2026-11-26' });
      expect(shared).toHaveBeenCalledOnce();
    } finally { r.close(); }
  });
  it('a ruling publication warning blocks landing rather than falling back to the batch', async () => {
    const r = cardRepo();
    try {
      const shared = vi.fn(); const sinks = createFileItemSinks({ root: r.root, cardBranch: shared,
        rulingCardBranch: async () => ({ pushed: false, warning: 'unreadable origin' }) });
      await expect(sinks[FILE_ITEM_CARD_BRANCH_EFFECT]({ rel, content, rulingKey: key })).rejects.toThrow(/unreadable origin/);
      expect(shared).not.toHaveBeenCalled();
    } finally { r.close(); }
  });
  it('ruling identity is stable across head and display changes and carries the referral run and finding fingerprint', () => {
    const selected = [{ runId: 'referral-123', key: '["lens","file",1,"finding"]', file: 'a.mjs', summary: 'Finding' }];
    const a = buildRulingCardInput({ head: 'a'.repeat(40) }, { repo: 'o/r', pr: 7 }, selected);
    const b = buildRulingCardInput({ head: 'b'.repeat(40) }, { repo: 'o/r', pr: 7 }, [{ ...selected[0], index: 99 }]);
    expect(a.rulingKey).toMatch(/^referral-123:[a-f0-9]{64}$/); expect(b.rulingKey).toBe(a.rulingKey);
  });
});


describe('ruling lookup closed paths and durable publication', () => {
  it('finding 6: lookup parses escaped YAML ruling keys and blocks unparseable unrelated cards', () => {
    const r = cardRepo();
    try {
      r.put(rel, content.replace('rulingKey:', '"ruling\\u004bey":'));
      let sha = r.commit();
      r.git('update-ref', `refs/heads/${ruling.rulingBranch(key)}`, sha);
      expect(io(r).lookup(key)).toMatchObject({ ok: true, card: { rel, sha } });
      r.put('backlog/102-bad.md', '---\nbad: [\n---\n'); sha = r.commit();
      r.git('update-ref', `refs/heads/${ruling.rulingBranch(key)}`, sha);
      const result = io(r).lookup(key);
      expect(result).toMatchObject({ ok: false });
      expect(result.reason).toContain('nothing filed');
    } finally { r.close(); }
  });
  it('finding 5: reused ruling branches reject reverted code and merged side-parent history', () => {
    for (const kind of ['reverted code', 'merge']) {
      const r = cardRepo();
      try {
        r.put('scripts/hidden.mjs'); const side = r.commit();
        if (kind === 'reverted code') { r.git('rm', 'scripts/hidden.mjs'); r.commit(); }
        else r.git('reset', '--hard', r.baseline);
        r.put(rel, content); let sha = r.commit();
        if (kind === 'merge') sha = r.git('commit-tree', r.git('rev-parse', `${sha}^{tree}`).trim(), '-p', sha, '-p', side, '-m', 'merge side history').trim();
        r.git('update-ref', `refs/heads/${ruling.rulingBranch(key)}`, sha);
        expect(r.git('diff', '--name-status', r.baseline, sha)).toBe(`A\t${rel}\n`);
        const result = io(r).lookup(key);
        expect(result, kind).toMatchObject({ ok: false });
        expect(result.reason).toContain('nothing filed');
      } finally { r.close(); }
    }
  });
  it.each(['unreadable', 'truncated'])('ruling history lookup refuses %s per-commit evidence', kind => {
    const r = cardRepo();
    try {
      r.put(rel, content); const sha = r.commit();
      r.git('update-ref', `refs/heads/${ruling.rulingBranch(key)}`, sha);
      const result = ruling.lookupRulingCard({ root: r.root, rulingKey: key, git: (...args) => {
        if (args[0] === 'log') {
          if (kind === 'unreadable') throw new Error('history unavailable');
          return rel;
        }
        return r.git(...args);
      } });
      expect(result).toMatchObject({ ok: false }); expect(result.reason).toContain('nothing filed');
    } finally { r.close(); }
  });
  it.each(['local read error', 'origin read error', 'malformed origin listing', 'truncated tree', 'malformed frontmatter', 'duplicate keyed cards', 'wrong branch content'])('fails closed: %s', kind => {
    const r = cardRepo();
    try {
      if (['truncated tree', 'malformed frontmatter', 'duplicate keyed cards', 'wrong branch content'].includes(kind)) {
        r.put(rel, kind === 'malformed frontmatter' ? '---\nbad: [\n---\n' : content);
        if (kind === 'duplicate keyed cards') r.put('backlog/102-duplicate.md', content);
        if (kind === 'wrong branch content') r.put('scripts/extra.mjs');
        const commit = r.commit(); r.git('update-ref', `refs/heads/${ruling.rulingBranch(key)}`, commit);
      }
      const result = ruling.lookupRulingCard({ root: r.root, rulingKey: key, git: (...args) => {
        if (kind === 'local read error') throw new Error('local unreadable');
        if (args[0] === 'ls-remote') {
          if (kind === 'origin read error') throw new Error('origin unreadable');
          return kind === 'malformed origin listing' ? 'garbage' : '';
        }
        if (kind === 'truncated tree' && args[0] === 'ls-tree') return r.git(...args).slice(0, -1);
        return r.git(...args);
      } });
      expect(result).toMatchObject({ ok: false }); expect(result.reason).toContain('nothing filed');
    } finally { r.close(); }
  });
  it('oversized origin lookup stops with an operator fallback and no fetch or filing', () => {
    const r = cardRepo(), fetches = [];
    try {
      const result = ruling.lookupRulingCard({ root: r.root, rulingKey: key, git: (...args) => {
        if (args[0] === 'ls-remote') return Array.from({ length: 1025 }, (_, i) => `${r.baseline}\trefs/heads/lane/card-batch-${i}`).join('\n');
        if (args[0] === 'fetch') fetches.push(args);
        return r.git(...args);
      } });
      expect(result.ok).toBe(false); expect(result.reason).toContain('inspect or consolidate legacy branches');
      expect(result.reason).toContain('nothing filed'); expect(fetches).toEqual([]);
    } finally { r.close(); }
  });
  it.each([false, true])('origin-only card is reused, legacy=%s', legacy => {
    const r = cardRepo();
    try {
      r.put(rel, content); const sha = r.commit();
      const branch = legacy ? 'lane/card-batch-2026-11-26' : ruling.rulingBranch(key);
      const result = ruling.lookupRulingCard({ root: r.root, rulingKey: key, git: (...args) => {
        if (args[0] === 'ls-remote') return `${sha}\trefs/heads/${branch}\n`;
        if (args[0] === 'fetch') return ''; // objects already present; no transport
        return r.git(...args);
      } });
      if (legacy) { expect(result.ok).toBe(false); expect(result.reason).toMatch(/legacy batch/); }
      else expect(result).toMatchObject({ ok: true, card: { rel, branch, sha } });
    } finally { r.close(); }
  });
  it('file-item preserves exactly the keyed card on its own branch before a failed push; replay reuses it', async () => {
    const r = cardRepo();
    try {
      r.put(rel, content); r.git('config', 'user.name', 'Fixture'); r.git('config', 'user.email', 'fixture@card-ruling-fixture.dev');
      const pushes = []; let fail = true;
      const sink = createRulingCardBranchSink({ root: r.root, git: (args, opts) => {
        if (args[0] === 'ls-remote') return '';
        if (args[0] === 'push') { pushes.push(args); if (fail) throw new Error('offline'); return ''; }
        return execFileSync('git', ['-C', r.root, ...args], { ...opts, env: { ...opts.env,
          GIT_AUTHOR_NAME: 'Ruling Fixture', GIT_AUTHOR_EMAIL: 'fixture@card-ruling-fixture.dev',
          GIT_COMMITTER_NAME: 'Ruling Fixture', GIT_COMMITTER_EMAIL: 'fixture@card-ruling-fixture.dev' } });
      } });
      await expect(sink({ rel, content, rulingKey: key })).rejects.toThrow('offline');
      const branch = ruling.rulingBranch(key), sha = r.git('rev-parse', branch).trim();
      expect(r.git('show', `${branch}:${rel}`)).toBe(content);
      expect(r.git('diff', '--name-status', r.baseline, branch)).toBe(`A\t${rel}\n`);
      fail = false;
      expect(await sink({ rel, content, rulingKey: key })).toMatchObject({ pushed: true, alreadyPresent: true, sha });
      expect(r.git('rev-parse', branch).trim()).toBe(sha);
      expect(pushes.every(args => args.at(-1) === `${sha}:refs/heads/${branch}`)).toBe(true);
      expect(r.git('for-each-ref', '--format=%(refname)', 'refs/heads/lane/card-batch-*')).toBe('');
    } finally { r.close(); }
  });
});


/** Real scaffold and private-index publication, with only origin IO replaced. No real-index staging. */
async function freshlyPublishedRuling() {
  const r = cardRepo();
  try {
    const publication = createRulingCardBranchSink({ root: r.root, git: (args, opts) => {
      if (args[0] === 'ls-remote' || args[0] === 'push') return '';
      return execFileSync('git', ['-C', r.root, ...args], { ...opts, env: { ...opts.env,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Ruling Fixture', GIT_AUTHOR_EMAIL: 'fixture@card-ruling-fixture.dev',
        GIT_COMMITTER_NAME: 'Ruling Fixture', GIT_COMMITTER_EMAIL: 'fixture@card-ruling-fixture.dev' } });
    } });
    const sinks = createFileItemSinks({ root: r.root, rulingCardBranch: publication });
    await sinks[SCAFFOLD_EFFECT]({ abs: join(r.root, rel), rel, content });
    const published = await sinks[FILE_ITEM_CARD_BRANCH_EFFECT]({ rel, content, rulingKey: key });
    expect(r.git('ls-files', '--', rel)).toBe('');
    expect(r.git('status', '--porcelain', '--untracked-files=all', '--', rel)).toBe(`?? ${rel}\n`);
    const calls = [], verify = vi.fn(() => {
      expect(r.git('rev-parse', 'HEAD').trim()).toBe(published.sha);
      expect(r.git('status', '--porcelain', '--', rel)).toBe('');
      expect(readFileSync(join(r.root, rel), 'utf8')).toBe(content);
      return '{"verdict":{"ok":true}}';
    });
    const run = (gitOverride = () => undefined) => ruling.landRulingInLane(input, { lane: r.root, laneRunMjs: 'run.mjs',
      lookup: io(r).lookup, parse: JSON.parse, submit: value => value,
      scratchFile: () => join(r.root, 'pr-body.md'), writeFile: writeFileSync,
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'git') return gitOverride(args.slice(2)) ?? r.git(...args.slice(2));
        if (args.includes('verify')) return verify();
        if (args.includes('open-pr')) return '{"outcome":"opened","pr":77}';
        throw new Error('unexpected child; fresh publication must never file again');
      } });
    return { r, run, calls, verify, published };
  } catch (error) { r.close(); throw error; }
}

describe('published ruling card checkout with the actual scaffold and publication sinks', () => {
  it('fresh untracked scaffold and private-index publication reach real detached checkout and verification', async () => {
    const h = await freshlyPublishedRuling();
    try {
      let checkoutError;
      try { h.r.git('checkout', '--detach', h.published.sha); } catch (error) { checkoutError = error; }
      expect(String(checkoutError?.stderr)).toContain('untracked working tree files would be overwritten by checkout');
      expect(await h.run()).toMatchObject({ ok: true, pr: 77 });
      expect(prepVerdict(readFileSync(join(h.r.root, 'pr-body.md'), 'utf8'))).toMatchObject({ ok: true, waived: true });
      expect(h.verify).toHaveBeenCalledOnce();
      expect(h.calls.some(([, args]) => args.includes('checkout') && args.includes('--detach'))).toBe(true);
      expect(h.r.git('show', `${h.published.sha}:${rel}`)).toBe(content);
    } finally { h.r.close(); }
  });
  it.each(['changed working card', 'symlink working card', 'conflicting staged card', 'unreadable index'])('checkout reconciliation fails closed: %s', async kind => {
    const h = await freshlyPublishedRuling();
    try {
      if (kind === 'changed working card') h.r.put(rel, content + 'local work\n');
      if (kind === 'symlink working card') { unlinkSync(join(h.r.root, rel)); symlinkSync('100-existing.md', join(h.r.root, rel)); }
      if (kind === 'conflicting staged card') {
        h.r.put(rel, content + 'staged work\n'); h.r.git('add', '--', rel); h.r.put(rel, content);
      }
      const before = h.r.git('status', '--porcelain', '--untracked-files=all', '--', rel);
      const result = await h.run(args => { if (kind === 'unreadable index' && args[0] === 'ls-files') throw new Error('index unreadable'); });
      expect(result.ok).toBe(false);
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.calls.some(([, args]) => args.includes('open-pr'))).toBe(false);
      expect(h.r.git('status', '--porcelain', '--untracked-files=all', '--', rel)).toBe(before);
      expect(h.r.git('rev-parse', 'HEAD').trim()).toBe(h.r.baseline);
      expect(h.r.git('show', `${h.published.sha}:${rel}`)).toBe(content);
    } finally { h.r.close(); }
  });
});
