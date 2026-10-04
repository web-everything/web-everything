/**
 * @file review-prep-io.test.mjs — the `review-prep` io shell: reads a card, appends its review section,
 * commits, and shells `we:scripts/pr-land.mjs` — with no real `fs` mutation outside a temp dir and no real
 * `git`/`gh` subprocess (both injected).
 *
 * THE PROPERTY WORTH PINNING is the race guard: a `record` whose card changed since `read` makes NO write and
 * calls neither `exec` nor `runNode` — the deterministic stand-in for the `confirm` step this operation
 * deliberately does not have (see `review-prep-io.mjs`'s header).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contentHashOf, createReviewPrepReader, createReviewPrepSinks, readPrep, recordPrepVerdict, resolveCardPath,
  sectionRecorded, todayIso,
} from '../review-prep-io.mjs';
import { REVIEW_PREP_EFFECTS } from '../review-prep.mjs';
import { notApplied } from '../effect-executor.mjs';
import { acquireFixClaim } from '../../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot } from '../../conveyor/fix-claim-store.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-prep-io-'));
  mkdirSync(join(root, 'backlog'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const CARD_RAW = [
  '---',
  'kind: story',
  'size: 3',
  'status: open',
  'tags: [x, y]',
  'scope:',
  '  - we:scripts/foo.mjs',
  '  - we:scripts/bar.mjs',
  '---',
  '',
  '# A fake card for tests',
  '',
  'This card claims the sky is blue.',
  '',
].join('\n');

function writeCard(name, raw = CARD_RAW) {
  const path = join(root, 'backlog', name);
  writeFileSync(path, raw, 'utf8');
  return path;
}

describe('resolveCardPath', () => {
  it('resolves a hash-prefixed item to its card', () => {
    writeCard('9999-a-fake-card.md');
    expect(resolveCardPath({ item: '9999', cwd: root })).toBe(join(root, 'backlog', '9999-a-fake-card.md'));
  });

  it('resolves an exact `<item>.md` — a card whose slug IS its id', () => {
    writeCard('xk1tron.md');
    expect(resolveCardPath({ item: 'xk1tron', cwd: root })).toBe(join(root, 'backlog', 'xk1tron.md'));
  });

  it('refuses a missing item', () => {
    expect(() => resolveCardPath({ item: '404', cwd: root })).toThrow(/no backlog card matches/);
  });

  it('refuses an ambiguous item rather than guessing', () => {
    writeCard('42-first.md');
    writeCard('42-second.md');
    expect(() => resolveCardPath({ item: '42', cwd: root })).toThrow(/ambiguous/);
  });

  it('refuses an empty item', () => {
    expect(() => resolveCardPath({ item: '', cwd: root })).toThrow(/non-empty backlog id/);
  });
});

describe('readPrep', () => {
  it('reads frontmatter, body and scope — and hashes the raw bytes', () => {
    writeCard('9999-a-fake-card.md');
    const result = readPrep({ item: '9999', repo: 'web-everything/web-everything', cwd: root });
    expect(result.card.frontmatter).toMatchObject({ kind: 'story', size: 3, status: 'open', tags: ['x', 'y'] });
    expect(result.card.body).toContain('# A fake card for tests');
    expect(result.card.body).toContain('the sky is blue');
    expect(result.card.contentHash).toBe(contentHashOf(CARD_RAW));
    expect(result.scopeFiles).toEqual(['we:scripts/foo.mjs', 'we:scripts/bar.mjs']);
  });

  it('refuses a malformed repo rather than reading a card for nobody', () => {
    writeCard('9999-a-fake-card.md');
    expect(() => readPrep({ item: '9999', repo: 'not-a-repo', cwd: root })).toThrow(/owner\/name/);
  });

  it('`createReviewPrepReader` binds cwd, giving the declaration\'s injected `{item, repo}` shape', () => {
    writeCard('9999-a-fake-card.md');
    const reader = createReviewPrepReader({ cwd: root });
    const result = reader({ item: '9999', repo: 'web-everything/web-everything' });
    expect(result.scopeFiles).toEqual(['we:scripts/foo.mjs', 'we:scripts/bar.mjs']);
  });
});

describe('contentHashOf', () => {
  it('is deterministic and sensitive to a single byte', () => {
    expect(contentHashOf('a')).toBe(contentHashOf('a'));
    expect(contentHashOf('a')).not.toBe(contentHashOf('b'));
  });
});

describe('todayIso', () => {
  it('formats YYYY-MM-DD from a fixed clock', () => {
    expect(todayIso(new Date(2026, 7, 14))).toBe('2026-08-14'); // month is 0-indexed
  });
});

describe('recordPrepVerdict — the race guard', () => {
  it('a card that changed since it was read makes NO write and calls neither exec nor runNode', async () => {
    const path = writeCard('9999-a-fake-card.md');
    const calls = [];
    const result = await recordPrepVerdict({
      item: '9999',
      repo: 'web-everything/web-everything',
      cwd: root,
      confidence: 'High',
      risks: [],
      corrections: [],
      fixApplied: false,
      note: '',
      expectedContentHash: 'a-hash-that-will-never-match-the-live-file',
      exec: () => { calls.push('exec'); return ''; },
      runNode: () => { calls.push('runNode'); return '{}'; },
    });
    expect(result).toMatchObject({ recorded: false, aborted: true });
    expect(result.reason).toMatch(/changed since it was read/);
    expect(calls).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(CARD_RAW); // byte-for-byte unchanged
  });

  it('a matching hash proceeds to write, commit and land', async () => {
    const path = writeCard('9999-a-fake-card.md');
    const calls = [];
    const result = await recordPrepVerdict({
      item: '9999',
      repo: 'web-everything/web-everything',
      cwd: root,
      confidence: 'High',
      risks: [{ risk: 'premise', addressed: true, note: 'checked against live code' }],
      corrections: [],
      fixApplied: false,
      note: 'the preparation holds up',
      expectedContentHash: contentHashOf(CARD_RAW),
      exec: (cmd, args) => { calls.push([cmd, args]); return args[0] === 'rev-parse' ? 'deadbeefcafe\n' : ''; },
      runNode: (argv) => { calls.push(['node', argv]); return JSON.stringify({ ok: true }); },
      readStagedContent: (relPath) => readFileSync(join(root, relPath), 'utf8'),
      hasCredential: () => true, // a credentialed host — the default `land: true` path, byte-identical to today
    });
    expect(result).toMatchObject({
      recorded: true, verified: true, aborted: false, clean: true, disposition: 'landed', pushed: true, landed: true,
    });
    const updated = readFileSync(path, 'utf8');
    expect(updated).toContain('## Independent review — ');
    expect(updated).toContain('Confidence: **High**');
    expect(updated).toContain('premise');
    // git add / commit / rev-parse, then the pr-land shell.
    expect(calls[0]).toEqual(['git', ['add', '--', 'backlog/9999-a-fake-card.md']]);
    expect(calls[1][0]).toBe('git');
    expect(calls[1][1][0]).toBe('commit');
    expect(calls[2]).toEqual(['git', ['rev-parse', 'HEAD']]);
    const landCall = calls[3];
    expect(landCall[0]).toBe('node');
    expect(landCall[1]).toContain(`${join(root, 'scripts', 'pr-land.mjs')}`);
    expect(landCall[1]).toContain('--label-on-green');
    expect(landCall[1]).toContain('--sha=deadbeefcafe');
    // THE BODY RIDES A FILE, NEVER `--body=<text>` — pr-land's own argv regex has no `s` flag, so a
    // multi-line `--body=` value fails the match outright and silently resolves to no body at all,
    // reproduced live against a real card (#1637) as pr-land's `empty-body` refusal.
    const bodyFlag = landCall[1].find((a) => a.startsWith('--body-file='));
    expect(bodyFlag).toBeTruthy();
    expect(landCall[1].some((a) => a.startsWith('--body='))).toBe(false);
    const bodyFilePath = bodyFlag.slice('--body-file='.length);
    const stagedBody = readFileSync(bodyFilePath, 'utf8');
    expect(stagedBody).toContain('Independent review of #9999');
    expect(stagedBody).toContain('## Independent review — ');
    // EXACT count (#3233) — a stray `git push` at calls[4] would leave this green while violating the very
    // sentence this criterion protects: the default path pushes exactly once, THROUGH pr-land, never twice.
    expect(calls).toHaveLength(4);
  });
});

describe('recordPrepVerdict — `land` (#3233): always pushes, `pr-land` only when landing', () => {
  const baseArgs = (overrides = {}) => ({
    item: '9999',
    repo: 'web-everything/web-everything',
    cwd: root,
    confidence: 'High',
    risks: [{ risk: 'premise', addressed: true }],
    corrections: [],
    fixApplied: false,
    note: '',
    expectedContentHash: contentHashOf(CARD_RAW),
    readStagedContent: (relPath) => readFileSync(join(root, relPath), 'utf8'),
    ...overrides,
  });

  it('an explicit `land: false` pushes exactly once — by SHA, not a branch tip — and never shells pr-land', async () => {
    writeCard('9999-a-fake-card.md');
    const gitCalls = [];
    const runNodeCalls = [];
    const result = await recordPrepVerdict(baseArgs({
      land: false,
      hasCredential: () => true, // present but irrelevant — an explicit `false` needs no probe
      exec: (cmd, args) => { gitCalls.push(args); return args[0] === 'rev-parse' ? 'deadbeefcafe\n' : ''; },
      runNode: (argv) => { runNodeCalls.push(argv); return '{}'; },
    }));
    expect(runNodeCalls).toHaveLength(0); // pr-land never shelled
    const pushCalls = gitCalls.filter((a) => a[0] === 'push');
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toEqual(['push', 'origin', 'deadbeefcafe:refs/heads/lane/review-prep-9999-deadbeef']);
    expect(result).toMatchObject({
      recorded: true, verified: true, pushed: true, landed: false, clean: true, sha: 'deadbeefcafe',
      ref: 'lane/review-prep-9999-deadbeef',
    });
    expect(result.reason).toBeUndefined(); // asked for, not downgraded
    expect(result.disposition).toBeUndefined();
    expect(result.land).toBeUndefined();
    expect(Array.isArray(result.followUp)).toBe(true);
    expect(result.followUp[0]).toContain('--ref=lane/review-prep-9999-deadbeef');
  });

  it('#4293 — refuses to push a ref another fixer already holds the LIVE claim on, never pushes', async () => {
    writeCard('9999-a-fake-card.md');
    const priorRoot = process.env.WE_COORDINATION_ROOT;
    const claimRoot = mkdtempSync(join(tmpdir(), 'we-fix-claim-'));
    process.env.WE_COORDINATION_ROOT = claimRoot;
    try {
      // sha is pinned to 'deadbeefcafe' by the `rev-parse` stub below → ref = lane/review-prep-9999-deadbeef.
      acquireFixClaim({ repo: 'web-everything/web-everything', pr: 4293, who: 'fixer-4293', branch: 'lane/review-prep-9999-deadbeef', lockRoot: fixDispatchClaimRoot() });
      const gitCalls = [];
      const result = await recordPrepVerdict(baseArgs({
        land: false,
        exec: (cmd, args) => { gitCalls.push(args); return args[0] === 'rev-parse' ? 'deadbeefcafe\n' : ''; },
      }));
      expect(gitCalls.some((a) => a[0] === 'push')).toBe(false);
      expect(result).toMatchObject({
        recorded: true, verified: true, pushed: false, landed: false, sha: 'deadbeefcafe',
        ref: 'lane/review-prep-9999-deadbeef',
      });
      expect(result.reason).toMatch(/holds the fix claim on PR #4293/);
    } finally {
      rmSync(claimRoot, { recursive: true, force: true });
      if (priorRoot === undefined) delete process.env.WE_COORDINATION_ROOT; else process.env.WE_COORDINATION_ROOT = priorRoot;
    }
  });

  it('the default `land: true` DOWNGRADES to push-only on a credential-less host — never refuses', async () => {
    writeCard('9999-a-fake-card.md');
    const gitCalls = [];
    const runNodeCalls = [];
    const result = await recordPrepVerdict(baseArgs({
      hasCredential: () => false, // the stubbed cloud-VM host this card exists for
      exec: (cmd, args) => { gitCalls.push(args); return args[0] === 'rev-parse' ? 'deadbeefcafe\n' : ''; },
      runNode: (argv) => { runNodeCalls.push(argv); return '{}'; },
    }));
    expect(gitCalls.some((a) => a[0] === 'add')).toBe(true);
    expect(gitCalls.some((a) => a[0] === 'commit')).toBe(true);
    expect(gitCalls.some((a) => a[0] === 'push')).toBe(true);
    expect(runNodeCalls).toHaveLength(0);
    expect(result).toMatchObject({ landed: false, reason: 'no-credential', clean: true, pushed: true });
    expect(Array.isArray(result.followUp)).toBe(true);
  });

  it('resuming a run record with NO `land` key at all still lands — `?? true` reads today\'s behaviour', async () => {
    writeCard('9999-a-fake-card.md');
    const runNodeCalls = [];
    // `land` is simply absent from the call, the exact shape a pre-#3233 suspended run's stored payload has.
    const result = await recordPrepVerdict(baseArgs({
      hasCredential: () => true,
      exec: (cmd, args) => (args[0] === 'rev-parse' ? 'deadbeefcafe\n' : ''),
      runNode: (argv) => { runNodeCalls.push(argv); return '{}'; },
    }));
    expect(runNodeCalls).toHaveLength(1);
    expect(result).toMatchObject({ landed: true, pushed: true, disposition: 'landed' });
  });

  it('a failed push is determinate — commit intact, `pushed: false`, `followUp` owed, never a throw', async () => {
    writeCard('9999-a-fake-card.md');
    const result = await recordPrepVerdict(baseArgs({
      land: false,
      exec: (cmd, args) => {
        if (args[0] === 'push') throw new Error('remote: permission denied');
        return args[0] === 'rev-parse' ? 'deadbeefcafe\n' : '';
      },
      runNode: () => { throw new Error('must not be reached'); },
    }));
    expect(result).toMatchObject({
      recorded: true, verified: true, pushed: false, landed: false, sha: 'deadbeefcafe',
    });
    expect(Array.isArray(result.followUp)).toBe(true);
  });
});

describe('sectionRecorded', () => {
  it('is true when the section is present in the content', () => {
    expect(sectionRecorded('before\n## Independent review — 2026-08-21\nafter', '## Independent review — 2026-08-21')).toBe(true);
  });

  it('is false when the section is absent', () => {
    expect(sectionRecorded('before\nafter', '## Independent review — 2026-08-21')).toBe(false);
  });

  it('is false for non-string content, never a throw', () => {
    expect(sectionRecorded(undefined, 'x')).toBe(false);
    expect(sectionRecorded(null, 'x')).toBe(false);
  });
});

describe('recordPrepVerdict — the post-write verify (#3230)', () => {
  it('a write that never reached the STAGED index reports the third outcome, not a bare success', async () => {
    const path = writeCard('9999-a-fake-card.md');
    const addCalls = [];
    const commitCalls = [];
    const landCalls = [];
    const result = await recordPrepVerdict({
      item: '9999',
      repo: 'web-everything/web-everything',
      cwd: root,
      confidence: 'High',
      risks: [],
      corrections: [],
      fixApplied: false,
      note: '',
      expectedContentHash: contentHashOf(CARD_RAW),
      exec: (cmd, args) => {
        if (args[0] === 'add') addCalls.push(args);
        if (args[0] === 'commit') commitCalls.push(args);
        return args[0] === 'rev-parse' ? 'deadbeefcafe\n' : '';
      },
      runNode: (argv) => { landCalls.push(argv); return '{}'; },
      // the staged index still holds the card's PRE-write text — the write never landed there.
      readStagedContent: () => CARD_RAW,
    });
    expect(result).toMatchObject({ recorded: false, verified: false, path });
    // staging DID happen (it precedes verification by design); commit and pr-land never ran.
    expect(addCalls.length).toBe(1);
    expect(commitCalls.length).toBe(0);
    expect(landCalls.length).toBe(0);
  });

  it('the verification predicate reads whatever `readStagedContent` returns, not the working tree', async () => {
    const path = writeCard('9999-a-fake-card.md');
    let stagedSnapshot = null;
    const result = await recordPrepVerdict({
      item: '9999',
      repo: 'web-everything/web-everything',
      cwd: root,
      confidence: 'High',
      risks: [{ risk: 'premise', addressed: true }],
      corrections: [],
      fixApplied: false,
      note: '',
      expectedContentHash: contentHashOf(CARD_RAW),
      exec: (cmd, args) => {
        if (args[0] === 'add') {
          // capture what actually got staged, then a CONCURRENT writer clobbers the working tree —
          // AFTER the stage, which is exactly the window round 1's working-tree re-read could not see.
          stagedSnapshot = readFileSync(path, 'utf8');
          writeFileSync(path, 'a concurrent writer clobbered the working tree\n', 'utf8');
        }
        return args[0] === 'rev-parse' ? 'deadbeefcafe\n' : '';
      },
      runNode: () => '{}',
      readStagedContent: () => stagedSnapshot,
      hasCredential: () => true,
    });
    expect(result).toMatchObject({ recorded: true, verified: true });
    // the working tree is now garbage — proving the check did not read it.
    expect(readFileSync(path, 'utf8')).not.toContain('## Independent review');
  });
});

describe('recordPrepVerdict — real git, no mocked `exec`: the actual commit captures the staged bytes', () => {
  // This is the test that catches a REAL git footgun the mocked tests above cannot: `git commit -- <path>`
  // re-reads `<path>` from the WORKING TREE at commit time (a pathspec-qualified commit bypasses the index),
  // which would silently commit a post-stage clobber even though the verify step (above) correctly checked
  // the index. Real `git` runs here — via `execFileIn`-equivalent `exec` and the DEFAULT `readStagedContent`
  // (real `git show :<path>`) — so a regression back to a pathspec-qualified `commitStagedCard` reddens this.
  it('a working-tree clobber AFTER staging does not leak into the real commit', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    // LOCAL identity, scoped to this throwaway temp repo only — CI runners carry no ambient git identity,
    // so relying on one (as an earlier version of this test did) fails there while passing locally.
    execFileSync('git', ['config', 'user.email', 'review-prep-io-test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'review-prep-io test'], { cwd: root });
    const path = writeCard('9999-a-fake-card.md');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

    const clobberText = 'a concurrent writer clobbered the working tree\n';
    const result = await recordPrepVerdict({
      item: '9999',
      repo: 'web-everything/web-everything',
      cwd: root,
      confidence: 'High',
      risks: [{ risk: 'premise', addressed: true }],
      corrections: [],
      fixApplied: false,
      note: '',
      expectedContentHash: contentHashOf(CARD_RAW),
      exec: (cmd, args, opts) => {
        const out = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
        if (cmd === 'git' && args[0] === 'add') writeFileSync(path, clobberText, 'utf8');
        return out;
      },
      runNode: () => '{}',
      hasCredential: () => true,
      // `readStagedContent` left at its DEFAULT (real `git show :path`) — this is the line #3230 exists for.
    });

    expect(result).toMatchObject({ recorded: true, verified: true });
    const committed = execFileSync('git', ['show', 'HEAD:backlog/9999-a-fake-card.md'], { cwd: root, encoding: 'utf8' });
    expect(committed).toContain('## Independent review');
    expect(committed).not.toContain('clobbered');
    // the working tree itself is still garbage — proving the committed bytes came from the index, not a re-read.
    expect(readFileSync(path, 'utf8')).toBe(clobberText);
  });
});

describe('recordPrepVerdict — land vs park', () => {
  const baseArgs = (overrides = {}) => ({
    item: '9999',
    repo: 'web-everything/web-everything',
    cwd: root,
    expectedContentHash: contentHashOf(CARD_RAW),
    exec: (cmd, args) => (args[0] === 'rev-parse' ? 'deadbeefcafe\n' : ''),
    runNode: () => '{}',
    readStagedContent: (relPath) => readFileSync(join(root, relPath), 'utf8'),
    hasCredential: () => true, // a credentialed host — land vs park is orthogonal to #3233's downgrade
    ...overrides,
  });

  it('parks (never lands) when a risk is left unaddressed', async () => {
    writeCard('9999-a-fake-card.md');
    const seen = [];
    const result = await recordPrepVerdict(baseArgs({
      confidence: 'High',
      risks: [{ risk: 'consumer', addressed: false, note: 'a caller outside scope: was found' }],
      runNode: (argv) => { seen.push(argv); return '{}'; },
    }));
    expect(result.clean).toBe(false);
    expect(result.disposition).toBe('parked');
    expect(seen[0]).toContain('--park=review:pending');
    expect(seen[0].some((a) => a === '--label-on-green')).toBe(false);
  });

  it('parks when a correction was applied, even at High confidence with all risks addressed', async () => {
    writeCard('9999-a-fake-card.md');
    const seen = [];
    await recordPrepVerdict(baseArgs({
      confidence: 'High',
      risks: [{ risk: 'premise', addressed: true }],
      corrections: ['the cited line number is stale'],
      fixApplied: true,
      runNode: (argv) => { seen.push(argv); return '{}'; },
    }));
    expect(seen[0]).toContain('--park=review:pending');
  });

  it('parks at Low confidence regardless of risk state', async () => {
    writeCard('9999-a-fake-card.md');
    const seen = [];
    await recordPrepVerdict(baseArgs({
      confidence: 'Low', risks: [], runNode: (argv) => { seen.push(argv); return '{}'; },
    }));
    expect(seen[0]).toContain('--park=review:pending');
  });

  it('lands cleanly at High confidence, every risk addressed, no corrections', async () => {
    writeCard('9999-a-fake-card.md');
    const seen = [];
    const result = await recordPrepVerdict(baseArgs({
      confidence: 'High',
      risks: [{ risk: 'premise', addressed: true }, { risk: 'interface', addressed: true }],
      runNode: (argv) => { seen.push(argv); return '{}'; },
    }));
    expect(result.clean).toBe(true);
    expect(result.verified).toBe(true);
    expect(seen[0]).toContain('--label-on-green');
  });
});

describe('recordPrepVerdict — failure classification', () => {
  it('a git commit failure is `notApplied` — nothing pushed, safe to retry', async () => {
    writeCard('9999-a-fake-card.md');
    await expect(recordPrepVerdict({
      item: '9999', repo: 'web-everything/web-everything', cwd: root, confidence: 'High', risks: [],
      expectedContentHash: contentHashOf(CARD_RAW),
      exec: () => { throw new Error('nothing to commit'); },
      runNode: () => { throw new Error('must not be reached'); },
    })).rejects.toMatchObject({ notApplied: true });
  });

  it('a pr-land failure AFTER a local commit is INDETERMINATE, not notApplied — the commit already happened', async () => {
    const path = writeCard('9999-a-fake-card.md');
    const err = await recordPrepVerdict({
      item: '9999', repo: 'web-everything/web-everything', cwd: root, confidence: 'High', risks: [],
      expectedContentHash: contentHashOf(CARD_RAW),
      exec: (cmd, args) => (args[0] === 'rev-parse' ? 'deadbeefcafe\n' : ''),
      runNode: () => { throw new Error('gh: network unreachable'); },
      readStagedContent: () => readFileSync(path, 'utf8'),
      hasCredential: () => true, // must take the landing branch for `runNode` (pr-land) to be reached at all
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.notApplied).toBeUndefined();
    expect(String(err.message)).toMatch(/UNKNOWN/);
    expect(String(err.message)).toContain('deadbeefcafe');
  });
});

describe('createReviewPrepSinks', () => {
  it('wires the RECORD and NOTICE effect types', () => {
    const sinks = createReviewPrepSinks({ root });
    expect(typeof sinks[REVIEW_PREP_EFFECTS.RECORD]).toBe('function');
    expect(typeof sinks[REVIEW_PREP_EFFECTS.NOTICE]).toBe('function');
  });

  it('the NOTICE sink reports through the injected channel and writes nothing', async () => {
    const lines = [];
    const sinks = createReviewPrepSinks({ root, out: (l) => lines.push(l) });
    const result = await sinks[REVIEW_PREP_EFFECTS.NOTICE]({ notice: 'Card o/n#7 — recorded.' });
    expect(result).toEqual({ reported: true });
    expect(lines).toEqual(['Card o/n#7 — recorded.']);
  });
});

// `notApplied` re-export sanity — used above via `.toMatchObject({ notApplied: true })`; this just documents
// the helper is the SAME one `review-pr-io.mjs` uses, not a lookalike.
describe('notApplied', () => {
  it('marks an error so the executor retries rather than replays it as indeterminate', () => {
    expect(notApplied('x').notApplied).toBe(true);
  });
});

describe('review-prep-io.mjs — the docs describe the credential downgrade, not automatic landing (#3233)', () => {
  const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'review-prep-io.mjs'), 'utf8');
  const fileHeader = SOURCE.split('\n').slice(0, 31).join('\n'); // the `@file`/`@description` block

  it('the file header no longer describes landing as automatic — it names the credential downgrade', () => {
    expect(fileHeader).not.toMatch(/LANDS OR PARKS/);
    expect(fileHeader).toMatch(/downgrad/i);
    expect(fileHeader).toMatch(/followUp/);
  });

  it('`recordPrepVerdict`\'s own JSDoc no longer contains the stale "LANDS OR PARKS" string', () => {
    expect(SOURCE).not.toContain('LANDS OR PARKS');
    expect(SOURCE).toMatch(/downgrad/i);
  });
});

// Real guarded writer, temporary cards, and stubbed publication transports.
describe('#3238 guarded review writes', () => {
  it.each([
    ['locus', 'Inspect scripts/operations/review-prep.mjs'],
    ['secret', 'Credential: ' + 'ghp_' + 'a'.repeat(36)],
    ['lane-guard', 'A clean review in a primary checkout'],
  ])('%s refusal leaves the card unchanged and performs no publication', async (reason, note) => {
    const cwd = reason === 'lane-guard' ? join(realpathSync(root), 'web-everything') : root;
    mkdirSync(join(cwd, 'backlog'), { recursive: true });
    const path = join(cwd, 'backlog', '9999-a-fake-card.md');
    writeFileSync(path, CARD_RAW);
    const calls = [];
    const result = await recordPrepVerdict({
      item: '9999', repo: 'web-everything/web-everything', cwd, confidence: 'High', note,
      hasCredential: () => true,
      exec: (...args) => { calls.push(args); return 'deadbeefcafe'; },
      runNode: (...args) => { calls.push(args); return '{}'; },
      readStagedContent: () => readFileSync(path, 'utf8'),
    });
    expect(result).toMatchObject({ recorded: false, verified: false, reason, path });
    expect(readFileSync(path, 'utf8')).toBe(CARD_RAW);
    expect(calls).toEqual([]);
  });
});
