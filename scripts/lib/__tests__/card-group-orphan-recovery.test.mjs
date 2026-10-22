// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardGrouping, readGroupState } from '../card-group.mjs';

const CARD = 'backlog/5360-prevention-card.md';
const accepted = [{ name: 'ready-to-merge' }, { name: 'review:accepted' }];
const settings = { enabled: true, maxSize: 8, eligibility: 'card-only', reconcileSec: 120, retryMin: 30, sources: {} };
const card = nums => `---\nstatus: open\n---\n\n# Card\n\nBody.\n\n## Also raised by\n\n${nums.map(n => `- Also raised by web-everything/web-everything#${n} (finding 1: \`we:backlog/6000-x.md:1\` — gate it.)`).join('\n')}\n`;

describe('card group orphan ownership', () => {
  it.each(['sources', 'cards', 'same id', 'pending same id'])('expired creation retains orphan ownership beside a competing group (%s) until closure succeeds', collision => {
    const cwd = mkdtempSync(join(tmpdir(), 'card-group-orphan-'));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
    try {
      git('init', '-q', '-b', 'main'); mkdirSync(join(cwd, 'backlog'));
      writeFileSync(join(cwd, CARD), card([1, 2]));
      git('add', '.'); git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD'), heads = { 3: 'e'.repeat(40) };
      for (const num of [1, 2]) {
        git('checkout', '-q', '-b', `source-${num}`, base);
        writeFileSync(join(cwd, CARD), card([1, 2, 9 + num]));
        git('add', '.'); git('commit', '-qm', `source-${num}`);
        heads[num] = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main');
      }
      const statePath = join(cwd, 'groups.json'), calls = [], logs = [];
      let clock = 1_000_000, closeFails = true, competitorClosed = false, competitor, grouping, closeAttempts = 0;
      const run = (cmd, args, opts = {}) => {
        if (args[0] === 'ls-remote') return { status: 0, stdout: args.at(-1) === 'refs/heads/main' ? `${base}\trefs/heads/main\n` : '' };
        if (args[0] === 'push') return { status: 0, stdout: '' };
        try { return { status: 0, stdout: execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...gitEnv, ...opts.env }, input: opts.input }) }; }
        catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
      };
      const exec = (_cmd, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'pr' && args[1] === 'create') {
          const pending = readGroupState(statePath).groups[0];
          clock += 16 * 60_000;
          expect(grouping.reconcile({ force: true }).dissolved).toEqual([pending.id]);
          competitor = { ...pending, id: collision.includes('same id') ? pending.id : 'competitor', pr: collision === 'pending same id' ? null : 88, createdAt: clock,
            sources: collision === 'cards' ? [{ num: 3, headSha: heads[3] }] : pending.sources };
          writeFileSync(statePath, JSON.stringify({ groups: [competitor], failed: {} }));
          return 'https://github.com/o/r/pull/77\n';
        }
        if (args[0] === 'pr' && args[1] === 'list') return '[]';
        if (args[0] === 'pr' && args[1] === 'close' && args[2] === '77') {
          closeAttempts++;
          if (closeFails) throw new Error('gh: 502');
        }
        if (args[0] === 'pr' && ['comment', 'close'].includes(args[1])) return '';
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
          state: args[2] === '88' && competitorClosed ? 'CLOSED' : 'OPEN', isDraft: false,
          headRefOid: heads[args[2]], headRefName: 'lane/source', baseRefName: 'main', labels: accepted,
          statusCheckRollup: [], mergeable: 'MERGEABLE',
        });
        throw new Error(`unexpected ${args.join(' ')}`);
      };
      const opts = { localSlug: 'o/r', cwd, run, exec, statePath, settings, now: () => clock,
        log: { write: line => logs.push(line) }, prestage: () => ({ allowed: true }),
        cardConflictSettings: { value: { autoResolveRaisedBy: true }, sources: {} },
        readQueueFiles: () => ({ entries: [] }), withLock: fn => ({ ran: true, result: fn() }) };
      grouping = createCardGrouping(opts);
      const result = grouping.form({
        outcomes: [1, 2].map(num => ({ num, kind: 'queue-file-overlap', reason: `#9 share ${CARD}` })),
        verdicts: [1, 2].map(num => ({ num, listedHeadSha: heads[num], prLabels: accepted })),
      });
      expect(result.formed, logs.join('')).toBeUndefined();
      let state = readGroupState(statePath);
      expect(state.groups.find(g => g.pr === competitor.pr)).toEqual(competitor);
      expect(state.groups.find(g => g.pr === 77), logs.join('')).toMatchObject({ closePending: true, sources: [{ num: 1 }, { num: 2 }], files: [CARD] });
      expect(result.reason).toMatch(/closure pending/);
      expect(calls.some(c => c.startsWith('pr comment'))).toBe(false);
      // A fresh process retries closure even with approved, unchanged sources.
      const restarted = createCardGrouping(opts);
      expect(restarted.holdFor({ num: 77 })?.kind).toBe('card-grouped');
      expect(restarted.holdFor({ num: 1 })?.kind).toBe('card-grouped');
      restarted.reconcile({ force: true });
      expect(readGroupState(statePath).groups.some(g => g.pr === 77)).toBe(true);
      closeFails = false;
      restarted.reconcile({ force: true });
      state = readGroupState(statePath);
      expect(closeAttempts).toBe(3);
      expect(state.groups.some(g => g.pr === 77)).toBe(false);
      expect(state.groups.find(g => g.pr === competitor.pr)).toEqual(competitor);
      expect(restarted.holdFor({ num: collision === 'cards' ? 3 : 1 })?.kind).toBe('card-grouped');
      competitorClosed = true;
      if (competitor.pr === null) clock += 16 * 60_000;
      restarted.reconcile({ force: true });
      expect(readGroupState(statePath).groups).toEqual([]);
      expect(restarted.holdFor({ num: 1 })).toBeNull();
      expect(restarted.holdFor({ num: 77 })).toBeNull();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it.each(['adopt', 'expire', 'dissolve', 'merged'].flatMap(operation =>
    ['attemptId', 'createdAt', 'commit', 'branch', 'pr'].map(changed => [operation, changed])))('a stale %s reconcile preserves a replacement whose %s changed', (operation, changed) => {
    const cwd = mkdtempSync(join(tmpdir(), 'card-group-stale-'));
    try {
      const statePath = join(cwd, 'groups.json');
      const pending = operation === 'adopt' || operation === 'expire';
      const original = { id: 'same', attemptId: 'original', repo: 'o/r', pr: pending ? null : 77, createdAt: 1000,
        commit: 'a'.repeat(40), branch: 'lane/card-group-same', files: [CARD], sources: [] };
      const replacement = { ...original, [changed]: { attemptId: 'replacement', createdAt: 2000, commit: 'b'.repeat(40), branch: 'lane/card-group-new', pr: 88 }[changed] };
      writeFileSync(statePath, JSON.stringify({ groups: [original], failed: {} }));
      const exec = (_cmd, args) => {
        if (args[0] === 'pr' && ['list', 'view'].includes(args[1])) {
          // The unlocked external read resumes after another writer has replaced its snapshot.
          writeFileSync(statePath, JSON.stringify({ groups: [replacement], failed: {} }));
          if (args[1] === 'list') return JSON.stringify(operation === 'adopt' ? [{ number: 77 }] : []);
          return JSON.stringify({ state: operation === 'merged' ? 'MERGED' : 'CLOSED' });
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      };
      const grouping = createCardGrouping({ localSlug: 'o/r', cwd, statePath, settings, exec, log: { write() {} },
        now: () => 1_000_000,
        run: (_cmd, args) => ({ status: 0, stdout: args[0] === 'ls-remote' ? `${'c'.repeat(40)}\trefs/heads/main\n` : '' }) });
      expect(grouping.reconcile({ force: true }).error).toBeUndefined();
      expect(readGroupState(statePath).groups).toEqual([replacement]);
      expect(readGroupState(statePath).failed).toEqual({});
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
