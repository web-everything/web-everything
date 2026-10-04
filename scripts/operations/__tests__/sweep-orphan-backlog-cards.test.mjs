/**
 * @file sweep-orphan-backlog-cards.test.mjs — #4317 follow-up. The sweep that lands the BACKLOG of orphans the
 * pre-#4317 filing path left behind in a daemon clone. Every subprocess call is a scripted stub (`exec`), same
 * no-fs/no-subprocess convention `land-prevention-card.test.mjs` already uses — no real `node`, `git`,
 * `lane-pool.mjs` or `gh` runs here.
 */
import { describe, it, expect } from 'vitest';
import {
  parseOrphanCard, selectOrphanSurvivors, listUntrackedBacklogCards, readMainDedupeSets, queueLandedSurvivors,
  buildSweepCommitMessage, buildSweepPrBody, sweepOrphanBacklogCards, parseSweepArgv, runSweepOrphanBacklogCardsCli,
  parseCheckStandardsJson, findContentInvalidSurvivors, orphanDedupeKey,
} from '../sweep-orphan-backlog-cards.mjs';

const REGULAR = () => ({ isFile: () => true, isSymbolicLink: () => false });

// A real orphan's shape (#4317 approval-time filer): idempotency key, one guard.
const APPROVAL_CARD = (pr, sha, guard = 'Add the missing regression test.') => `---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/a.mjs"]
dateOpened: "2026-09-28"
tags: []
---

# File the prevention guard(s) owed by web-everything/web-everything#${pr}'s independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. \`we:scripts/a.mjs\` — ${guard}

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#${pr}@${sha}

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
`;

// A real orphan's shape (#2749 unattended-review-loop filer): no idempotency key, title-only source.
const LOOP_CARD = (pr, sha, guard = 'Add a concurrency test.') => `---
kind: story
size: 3
status: open
scope: ["we:scripts/b.mjs"]
dateOpened: "2026-09-27"
tags: []
---

# File the prevention guard(s) owed by web-everything/web-everything#${pr}'s independent review

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#${pr}'s review (reviewed head \`${sha}\`) to prevention-outstanding by naming a guard neither captured nor filed:

1. \`we:scripts/b.mjs\` — ${guard}

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
`;

describe('parseOrphanCard', () => {
  it('reads the approval-time shape: hashId, status, kind, sourceRef from the idempotency key', () => {
    const c = parseOrphanCard('backlog/xab12cd-file-the-prevention.md', APPROVAL_CARD(2900, 'deadbeef'));
    expect(c.hashId).toBe('xab12cd');
    expect(c.status).toBe('open');
    expect(c.kind).toBe('story');
    expect(c.sourceRef).toBe('web-everything/web-everything#2900');
  });

  it('reads the review-loop shape: no idempotency key, sourceRef falls back to the title', () => {
    const c = parseOrphanCard('backlog/xef34gh-file-the-prevention.md', LOOP_CARD(2821, 'cafef00d'));
    expect(c.sourceRef).toBe('web-everything/web-everything#2821');
  });

  it('two cards for the SAME PR + SAME guard hash identically; a different guard hashes differently', () => {
    const a = parseOrphanCard('backlog/xaaaaaa-x.md', APPROVAL_CARD(100, 'sha1', 'Add test A.'));
    const b = parseOrphanCard('backlog/xbbbbbb-x.md', APPROVAL_CARD(100, 'sha2', 'Add test A.'));
    const c = parseOrphanCard('backlog/xcccccc-x.md', APPROVAL_CARD(100, 'sha3', 'Add DIFFERENT test.'));
    expect(a.digestHash).toBe(b.digestHash); // different head sha, same guard text → same debt
    expect(a.digestHash).not.toBe(c.digestHash);
  });

  // PR #2901 review: the digest must cover the guard lines ONLY — every incidental field (dateOpened, scope,
  // the loop shape's own `reviewed head` sha, the idempotency key) must vary without changing it.
  it('same PR + same guard hash identically across a different dateOpened, scope, and loop-shape head sha', () => {
    const loopA = parseOrphanCard('backlog/xaaaaaa-x.md', LOOP_CARD(100, 'sha1', 'Same guard.'));
    const loopB = parseOrphanCard('backlog/xbbbbbb-x.md', LOOP_CARD(100, 'sha2', 'Same guard.'));
    expect(loopA.digestHash).toBe(loopB.digestHash);
    const approvalOtherDay = APPROVAL_CARD(100, 'sha3', 'Same guard.')
      .replace('dateOpened: "2026-09-28"', 'dateOpened: "2026-09-29"')
      .replace('scope: ["we:scripts/a.mjs"]', 'scope: ["we:scripts/z.mjs"]');
    const a = parseOrphanCard('backlog/xcccccc-x.md', APPROVAL_CARD(100, 'sha4', 'Same guard.'));
    const b = parseOrphanCard('backlog/xdddddd-x.md', approvalOtherDay);
    expect(a.digestHash).toBe(b.digestHash);
  });

  it('a card with no recognizable hash-id filename gets a null hashId, never throws', () => {
    const c = parseOrphanCard('backlog/weird-name.md', APPROVAL_CARD(1, 's'));
    expect(c.hashId).toBeNull();
  });
});

describe('selectOrphanSurvivors', () => {
  it('drops an orphan whose hashId already carries a bornAs card on main', () => {
    const cards = [parseOrphanCard('backlog/xab12cd-a.md', APPROVAL_CARD(1, 's1'))];
    const { survivors, dropped } = selectOrphanSurvivors(cards, { mainBornAsIds: new Set(['xab12cd']) });
    expect(survivors).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toMatch(/bornAs: xab12cd/);
  });

  it('drops an orphan whose source PR AND guard already have a card on main, even with no bornAs match', () => {
    const onMain = parseOrphanCard('backlog/4400-a.md', `---\nbornAs: xqqqqqq\n${APPROVAL_CARD(42, 'other-head').slice(4)}`
      .replace('dateOpened: "2026-09-28"', 'dateOpened: "2026-09-26"'));
    const cards = [parseOrphanCard('backlog/xzzzzzz-a.md', APPROVAL_CARD(42, 's1'))];
    const { survivors, dropped } = selectOrphanSurvivors(cards, { mainGuardKeys: new Set([orphanDedupeKey(onMain)]) });
    expect(survivors).toEqual([]);
    expect(dropped[0].reason).toMatch(/covers web-everything\/web-everything#42/);
  });

  // PR #2901 review: a main card for the same PR with a DIFFERENT guard is different debt — never a drop.
  it('keeps an orphan whose source PR has a card on main that names a DIFFERENT guard', () => {
    const onMain = parseOrphanCard('backlog/4400-a.md', APPROVAL_CARD(42, 's0', 'Guard A.'));
    const cards = [parseOrphanCard('backlog/xzzzzzz-a.md', APPROVAL_CARD(42, 's1', 'Guard B.'))];
    const { survivors, dropped } = selectOrphanSurvivors(cards, { mainGuardKeys: new Set([orphanDedupeKey(onMain)]) });
    expect(survivors.map((s) => s.rel)).toEqual(['backlog/xzzzzzz-a.md']);
    expect(dropped).toEqual([]);
  });

  it('drops (leaves for a human) an untracked card that is not a mechanically-filed prevention card', () => {
    const cards = [parseOrphanCard('backlog/xzzzzzz-a.md', '---\nkind: story\nstatus: open\n---\n\n# Something else entirely\n')];
    const { survivors, dropped } = selectOrphanSurvivors(cards, {});
    expect(survivors).toEqual([]);
    expect(dropped[0].reason).toMatch(/not a mechanically-filed prevention card/);
  });

  it('among orphans, keeps the alphabetically-first of two citing the SAME PR + SAME guard, drops the other', () => {
    const cards = [
      parseOrphanCard('backlog/xbbbbbb-a.md', APPROVAL_CARD(7, 'sha2', 'Same guard.')),
      parseOrphanCard('backlog/xaaaaaa-a.md', APPROVAL_CARD(7, 'sha1', 'Same guard.')),
    ];
    const { survivors, dropped } = selectOrphanSurvivors(cards, {});
    expect(survivors.map((s) => s.rel)).toEqual(['backlog/xaaaaaa-a.md']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].rel).toBe('backlog/xbbbbbb-a.md');
    expect(dropped[0].duplicateOf).toBe('backlog/xaaaaaa-a.md');
  });

  it('keeps BOTH orphans that cite the same PR but a genuinely different guard', () => {
    const cards = [
      parseOrphanCard('backlog/xaaaaaa-a.md', APPROVAL_CARD(7, 'sha1', 'Guard one.')),
      parseOrphanCard('backlog/xbbbbbb-a.md', APPROVAL_CARD(7, 'sha2', 'Guard two.')),
    ];
    const { survivors, dropped } = selectOrphanSurvivors(cards, {});
    expect(survivors.map((s) => s.rel).sort()).toEqual(['backlog/xaaaaaa-a.md', 'backlog/xbbbbbb-a.md']);
    expect(dropped).toEqual([]);
  });

  it('a clean clone (nothing matches, nothing duplicates) survives whole', () => {
    const cards = [
      parseOrphanCard('backlog/xaaaaaa-a.md', APPROVAL_CARD(1, 's1')),
      parseOrphanCard('backlog/xbbbbbb-a.md', LOOP_CARD(2, 's2')),
    ];
    const { survivors, dropped } = selectOrphanSurvivors(cards, { mainBornAsIds: new Set(['xzzzzzz']) });
    expect(survivors).toHaveLength(2);
    expect(dropped).toEqual([]);
  });
});

describe('listUntrackedBacklogCards', () => {
  it('parses `git status --porcelain` output, skipping tracked/modified entries and non-hash-id paths', () => {
    const status = [
      '?? backlog/xab12cd-file-the-prevention.md',
      ' M backlog/4200-existing.md', // tracked, modified — never an "orphan"
      '?? backlog/not-a-hash-id.md', // untracked but not the hash-id shape — out of scope
      '?? scripts/some-other-file.mjs', // untracked, not under backlog/
    ].join('\n');
    const exec = (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['-C', '/clone', 'status', '--porcelain', '--untracked-files=all', '--', 'backlog']);
      return status;
    };
    const readFile = (p) => { expect(p).toBe('/clone/backlog/xab12cd-file-the-prevention.md'); return 'CONTENT'; };
    const out = listUntrackedBacklogCards('/clone', { exec, readFile, lstat: REGULAR });
    expect(out).toEqual([{ rel: 'backlog/xab12cd-file-the-prevention.md', content: 'CONTENT' }]);
  });

  // PR #2901 review: a planted untracked symlink must never have its TARGET's bytes read (and so landed).
  it('skips an untracked entry that is a symlink (or anything but a regular file) — never reads through it', () => {
    const exec = () => '?? backlog/xab12cd-planted.md\n?? backlog/xcd34ef-real.md';
    const read = [];
    const lstat = (p) => ({ isFile: () => !p.endsWith('planted.md'), isSymbolicLink: () => p.endsWith('planted.md') });
    const out = listUntrackedBacklogCards('/clone', { exec, lstat, readFile: (p) => { read.push(p); return 'C'; } });
    expect(out.map((o) => o.rel)).toEqual(['backlog/xcd34ef-real.md']);
    expect(read).toEqual(['/clone/backlog/xcd34ef-real.md']);
  });

  it('NEVER shells anything but the one read-only `git status` call — no add/commit path exists in this function', () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, args]); return ''; };
    listUntrackedBacklogCards('/clone', { exec, readFile: () => '', lstat: REGULAR });
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).not.toContain('add');
    expect(calls[0][1]).not.toContain('commit');
  });
});

describe('readMainDedupeSets', () => {
  const MAIN_CARD = LOOP_CARD(2807, 'h', 'Add the missing regression test.');
  const mainExec = (calls, { grep } = {}) => (cmd, args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'fetch' || args[0] === 'rev-parse') return '';
    if (args[0] === 'grep' && args.includes('^bornAs:')) return grep?.bornAs ?? 'bornAs: x21soye\nbornAs: x3qp94j\n';
    if (args[0] === 'grep') return grep?.titles ?? 'origin/main:backlog/4400-file-the-prevention.md\n';
    if (args[0] === 'show') return MAIN_CARD;
    throw new Error(`unexpected ${args.join(' ')}`);
  };

  it('reads bornAs ids and per-card PR+guard keys off origin/main, run in this repo with an explicit regex dialect', () => {
    const calls = [];
    const { mainBornAsIds, mainGuardKeys } = readMainDedupeSets({ exec: mainExec(calls), cwd: '/repo' });
    expect(mainBornAsIds).toEqual(new Set(['x21soye', 'x3qp94j']));
    expect(mainGuardKeys).toEqual(new Set([orphanDedupeKey(parseOrphanCard('backlog/4400-a.md', MAIN_CARD))]));
    expect(calls.every((c) => c.opts?.cwd === '/repo')).toBe(true);
    const greps = calls.filter((c) => c.args[0] === 'grep');
    expect(greps).toHaveLength(2);
    expect(greps.every((c) => c.args.includes('-G') && c.args.includes('origin/main'))).toBe(true);
    expect(calls.find((c) => c.args[0] === 'show').args).toEqual(['show', 'origin/main:backlog/4400-file-the-prevention.md']);
  });

  it('refreshes and verifies the ref before grepping it', () => {
    const calls = [];
    readMainDedupeSets({ exec: mainExec(calls), cwd: '/repo' });
    expect(calls[0].args).toEqual(['fetch', '--quiet', 'origin', 'main']);
    expect(calls[1].args).toEqual(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
  });

  it('a `git grep` with zero matches (exit 1, empty stdout) reads as an empty set, never an error', () => {
    const exec = (cmd, args) => {
      if (args[0] !== 'grep') return '';
      const e = new Error('exit 1'); e.status = 1; e.stdout = ''; throw e;
    };
    const { mainBornAsIds, mainGuardKeys } = readMainDedupeSets({ exec });
    expect(mainBornAsIds.size).toBe(0);
    expect(mainGuardKeys.size).toBe(0);
  });

  // PR #2901 review: a fatal grep (bad ref, not a repo — exit 128) must SURFACE, never read as "main is empty".
  it('a fatal `git grep` (exit 128) throws to the caller instead of returning empty sets', () => {
    const exec = (cmd, args) => {
      if (args[0] !== 'grep') return '';
      const e = new Error('fatal: not a git repository'); e.status = 128; e.stdout = ''; throw e;
    };
    expect(() => readMainDedupeSets({ exec })).toThrow(/not a git repository/);
  });

  it('a missing ref (rev-parse fails) throws before any grep runs', () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') { const e = new Error('Needed a single revision'); e.status = 1; throw e; }
      return '';
    };
    expect(() => readMainDedupeSets({ exec })).toThrow(/single revision/);
    expect(calls.some((a) => a[0] === 'grep')).toBe(false);
  });
});

describe('queueLandedSurvivors', () => {
  it('clears an open story/task by hashId, skips an already-queued one, skips epic/decision kinds', () => {
    const survivors = [
      { hashId: 'xaaaaaa', kind: 'story', status: 'open' },
      { hashId: 'xbbbbbb', kind: 'story', status: 'open' }, // already queued
      { hashId: 'xccccccc', kind: 'epic', status: 'open' }, // never dispatchable
      { hashId: null, kind: 'story', status: 'open' }, // no id to queue by
    ];
    let written = null;
    const queued = queueLandedSurvivors(survivors, {
      read: () => [{ num: 'xbbbbbb', addedAt: null }],
      writeQ: (q) => { written = q; },
      has: (q, id) => q.some((e) => e.num === id),
      add: (q, id) => [...q, { num: id, addedAt: 't' }],
      queuePath: () => '/fake/queue.json',
      now: () => 't',
    });
    expect(queued).toEqual(['xaaaaaa']);
    expect(written).toEqual([{ num: 'xbbbbbb', addedAt: null }, { num: 'xaaaaaa', addedAt: 't' }]);
  });

  it('never writes the sidecar when nothing changed', () => {
    let wrote = false;
    queueLandedSurvivors([{ hashId: 'xaaaaaa', kind: 'story', status: 'open' }], {
      read: () => [{ num: 'xaaaaaa' }],
      writeQ: () => { wrote = true; },
      has: () => true,
      add: (q) => q,
      queuePath: () => '/fake/queue.json',
    });
    expect(wrote).toBe(false);
  });
});

describe('parseCheckStandardsJson', () => {
  it('parses a clean single-line JSON report', () => {
    expect(parseCheckStandardsJson('{"ok":true,"errors":[]}')).toEqual({ ok: true, errors: [] });
  });

  it('returns null, never throws, on unparseable text', () => {
    expect(parseCheckStandardsJson('not json')).toBeNull();
    expect(parseCheckStandardsJson(undefined)).toBeNull();
  });
});

describe('findContentInvalidSurvivors', () => {
  const survivors = [
    { rel: 'backlog/xab12cd-a.md', hashId: 'xab12cd' },
    { rel: 'backlog/xbadcard-b.md', hashId: 'xbadcard' },
  ];

  it('matches an error to the survivor whose hash id appears in the message text', () => {
    const errors = [{ message: 'Backlog item "xbadcard-file-the-prevention" uses [[wiki-link]] syntax' }];
    const bad = findContentInvalidSurvivors(errors, survivors);
    expect(bad).toHaveLength(1);
    expect(bad[0].rel).toBe('backlog/xbadcard-b.md');
    expect(bad[0].reason).toMatch(/fails check:standards/);
  });

  it('implicates no one when no error message names any survivor\'s hash id', () => {
    const errors = [{ message: 'some unrelated repo-wide error' }];
    expect(findContentInvalidSurvivors(errors, survivors)).toEqual([]);
  });

  it('is a no-op on an empty or missing errors array', () => {
    expect(findContentInvalidSurvivors([], survivors)).toEqual([]);
    expect(findContentInvalidSurvivors(undefined, survivors)).toEqual([]);
  });
});

describe('buildSweepCommitMessage / buildSweepPrBody', () => {
  it('the commit message carries the attribution line and every survivor rel (or a bounded summary)', () => {
    const survivors = [{ rel: 'backlog/xaaaaaa-a.md' }, { rel: 'backlog/xbbbbbb-b.md' }];
    const msg = buildSweepCommitMessage(survivors, '/clone');
    expect(msg).toContain('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
    expect(msg).toContain('backlog/xaaaaaa-a.md');
    expect(msg).toContain('backlog/xbbbbbb-b.md');
  });

  it('the PR body names both what landed and what was dropped, with its reason', () => {
    const survivors = [{ rel: 'backlog/xaaaaaa-a.md' }];
    const dropped = [{ rel: 'backlog/xbbbbbb-b.md', reason: 'already landed on origin/main (a card there carries bornAs: xbbbbbb)' }];
    const body = buildSweepPrBody(survivors, dropped, '/clone');
    expect(body).toContain('backlog/xaaaaaa-a.md');
    expect(body).toContain('backlog/xbbbbbb-b.md');
    expect(body).toContain('bornAs: xbbbbbb');
  });

  // PR #2901 review: the local absolute path (home dir, username) must never reach git history or a PR body.
  it('names the source clone by its basename only — never the absolute local path', () => {
    const clone = '/Users/someone/workspace/wev-review-daemon';
    const msg = buildSweepCommitMessage([{ rel: 'backlog/xaaaaaa-a.md' }], clone);
    const body = buildSweepPrBody([{ rel: 'backlog/xaaaaaa-a.md' }], [], clone);
    for (const text of [msg, body]) {
      expect(text).toContain('wev-review-daemon');
      expect(text).not.toContain('/Users/someone');
    }
  });
});

// ── The full orchestration, scripted exec — mirrors land-prevention-card.test.mjs's own harness. ──────────────

function scriptedExec(steps) {
  let i = 0;
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const step = steps[i];
    i += 1;
    if (!step) throw new Error(`scriptedExec: no step scripted for call #${i} (${cmd} ${args.join(' ')})`);
    if (typeof step === 'function') return step(cmd, args, opts);
    if (step instanceof Error) throw step;
    return step;
  };
  return { exec, calls };
}

const ACQUIRE_OK = JSON.stringify({ lane: 9, path: '/workspace/.lanes/web-everything/lane-9', session: 's', holder: 'h' });
const CONTENT_CHECK_OK = JSON.stringify({ ok: true, errors: [], warnings: [] });
const VERIFY_GREEN = JSON.stringify({ verdict: { ok: true, passed: 3, failed: 0, unrun: 0, blocking: [] } });
const VERIFY_RED = JSON.stringify({ verdict: { ok: false, blocking: ['vitest'] } });
const OPEN_PR_OPENED = JSON.stringify({
  findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 7777, url: 'https://github.com/web-everything/web-everything/pull/7777' } }] } },
});

const ONE_CARD = () => [{ rel: 'backlog/xab12cd-a.md', content: APPROVAL_CARD(500, 'sha500') }];

describe('sweepOrphanBacklogCards — the real scan → dedupe → lane → commit → verify → open-pr → release sequence', () => {
  it('nothing to land: an all-duplicate clone never acquires a lane at all', async () => {
    const { exec, calls } = scriptedExec([]); // any call at all is a test failure
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's' }, {
      exec, write: () => {},
      listOrphans: () => ONE_CARD(),
      readMain: () => ({ mainBornAsIds: new Set(['xab12cd']), mainGuardKeys: new Set() }),
      queueSurvivors: () => [],
    });
    expect(result.ok).toBe(true);
    expect(result.landed).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('an empty clone (no untracked cards) is a clean no-op', async () => {
    const { exec, calls } = scriptedExec([]);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's' }, {
      exec, write: () => {}, listOrphans: () => [], readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('dry-run reports survivors + dropped, acquires no lane, writes nothing', async () => {
    const { exec, calls } = scriptedExec([]);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's', dryRun: true }, {
      exec, write: () => {}, listOrphans: () => ONE_CARD(), readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
    });
    expect(result).toEqual({ ok: true, step: 'dry-run', reason: null, landed: ['backlog/xab12cd-a.md'], dropped: [], pr: null, url: null });
    expect(calls).toHaveLength(0);
  });

  it('lands one survivor: acquires a lane, copies+commits+verifies+opens the PR, queues, releases', async () => {
    const written = [];
    const queuedWith = [];
    const { exec, calls } = scriptedExec([ACQUIRE_OK, 'added', CONTENT_CHECK_OK, 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'released']);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 'sweep-s' }, {
      exec, write: () => {},
      listOrphans: () => ONE_CARD(),
      readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
      queueSurvivors: (survivors) => { queuedWith.push(...survivors); return survivors.map((s) => s.hashId); },
      mkTmp: () => '/tmp/sweep-x', rmTmp: () => {}, writeFile: (p, c) => written.push({ p, c }),
    });
    expect(result).toEqual({ ok: true, step: 'done', reason: null, landed: ['backlog/xab12cd-a.md'], dropped: [], pr: 7777, url: 'https://github.com/web-everything/web-everything/pull/7777' });

    // acquire — a real lane.
    expect(calls[0].args[0]).toMatch(/scripts[/\\]lane-pool\.mjs$/);
    expect(calls[0].args.slice(1)).toEqual(['acquire', '--purpose=orphan-card-sweep', '--session=sweep-s', '--json']);
    // the survivor's content was copied byte-for-byte into the LANE (never touching /clone).
    expect(written.some((w) => w.p === '/workspace/.lanes/web-everything/lane-9/backlog/xab12cd-a.md' && w.c === APPROVAL_CARD(500, 'sha500'))).toBe(true);
    // add — exactly the one survivor path, in the lane.
    expect(calls[1].cmd).toBe('git');
    expect(calls[1].args).toEqual(['-C', '/workspace/.lanes/web-everything/lane-9', 'add', '--', 'backlog/xab12cd-a.md']);
    // content validation — the LANE's own check-standards.mjs, UNSCOPED, before the commit.
    expect(calls[2].args[0]).toBe('/workspace/.lanes/web-everything/lane-9/scripts/check-standards.mjs');
    expect(calls[2].args).toContain('--json');
    // commit — one commit, in the lane.
    expect(calls[3].args).toContain('commit');
    // verify — the LANE's own run.mjs, mode=run.
    expect(calls[4].args[0]).toBe('/workspace/.lanes/web-everything/lane-9/scripts/operations/run.mjs');
    expect(calls[4].args).toContain('verify');
    expect(calls[4].args).toContain('--mode=run');
    // open-pr — label-on-green, one PR for the whole batch.
    expect(calls[5].args).toContain('open-pr');
    expect(calls[5].args).toContain('--mode=label-on-green');
    // release — always, by lane number.
    expect(calls[6].args).toEqual(expect.arrayContaining(['release', '--lane=9', '--session=sweep-s']));
    // the conveyor queue-clear ran with the survivor, best-effort.
    expect(queuedWith).toHaveLength(1);
    // PR #2901 review: the read-only-clone invariant, asserted — no write and no git call ever targets /clone.
    expect(written.filter((w) => w.p.startsWith('/clone'))).toEqual([]);
    expect(calls.filter((c) => c.args.some((a) => String(a).startsWith('/clone')))).toEqual([]);
  });

  it('a red gate fails the sweep, never opens a PR, and STILL releases the lane', async () => {
    const { exec, calls } = scriptedExec([ACQUIRE_OK, 'added', CONTENT_CHECK_OK, 'committed', VERIFY_RED, 'released']);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's' }, {
      exec, write: () => {}, listOrphans: () => ONE_CARD(), readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
      mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.step).toBe('verify');
    expect(calls.at(-1).args).toEqual(expect.arrayContaining(['release', '--lane=9']));
    expect(calls.some((c) => c.args.includes('open-pr'))).toBe(false);
  });

  it('a refused acquire fails cleanly with no lane to release', async () => {
    const { exec, calls } = scriptedExec([new Error('lane pool exhausted')]);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's' }, {
      exec, write: () => {}, listOrphans: () => ONE_CARD(), readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
    });
    expect(result.ok).toBe(false);
    expect(result.step).toBe('acquire');
    expect(calls).toHaveLength(1); // no release call — nothing was ever acquired
  });

  // #4317 follow-up, live-caught 2026-09-29: a card whose reviewer-authored guard text trips check-standards'
  // own content rules (the wiki-link scan matched orphan x3hxr6i, PR #2872) must be dropped, never silently
  // rewritten, and must never sink the OTHER survivors in the same batch.
  it('drops a survivor that fails check:standards on its own content, lands the rest', async () => {
    const twoCards = () => [
      { rel: 'backlog/xab12cd-a.md', content: APPROVAL_CARD(500, 'sha500') },
      { rel: 'backlog/xbadcrd-b.md', content: APPROVAL_CARD(600, 'sha600') },
    ];
    const CONTENT_CHECK_ONE_BAD = JSON.stringify({
      ok: false,
      errors: [{ message: 'Backlog item "xbadcrd-file-the-prevention-guard-s-owed-by-chalbert-web-everything" uses [[wiki-link]] syntax at body line(s) 6' }],
    });
    const resetCalls = [];
    const removedFiles = [];
    const { exec, calls } = scriptedExec([
      ACQUIRE_OK, 'added',
      CONTENT_CHECK_ONE_BAD, // first pass: one bad card found
      'reset', // git reset -- the bad card
      CONTENT_CHECK_OK, // second pass: clean
      'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'released',
    ]);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's' }, {
      exec, write: () => {},
      listOrphans: () => twoCards(),
      readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
      queueSurvivors: () => [],
      mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {},
      rmFile: (p) => removedFiles.push(p),
    });
    expect(result.ok).toBe(true);
    expect(result.landed).toEqual(['backlog/xab12cd-a.md']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].rel).toBe('backlog/xbadcrd-b.md');
    expect(result.dropped[0].reason).toMatch(/fails check:standards/);
    expect(removedFiles).toEqual(['/workspace/.lanes/web-everything/lane-9/backlog/xbadcrd-b.md']);
    const resetCall = calls.find((c) => c.args.includes('reset'));
    expect(resetCall.args).toEqual(expect.arrayContaining(['backlog/xbadcrd-b.md']));
    // the surviving commit was built from the ONE good card only.
    const commitMsgWrite = calls.find((c) => c.args.includes('commit'));
    expect(commitMsgWrite).toBeTruthy();
  });

  it('fails cleanly (never commits) when EVERY survivor fails check:standards content validation', async () => {
    const CONTENT_CHECK_ALL_BAD = JSON.stringify({
      ok: false,
      errors: [{ message: 'Backlog item "xab12cd-file-the-prevention-guard-s-owed-by-chalbert-web-everything" uses [[wiki-link]] syntax' }],
    });
    const { exec, calls } = scriptedExec([ACQUIRE_OK, 'added', CONTENT_CHECK_ALL_BAD, 'reset', 'released']);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's' }, {
      exec, write: () => {}, listOrphans: () => ONE_CARD(), readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
      mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {}, rmFile: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.landed).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(calls.some((c) => c.args.includes('commit'))).toBe(false);
    expect(calls.at(-1).args).toEqual(expect.arrayContaining(['release']));
  });

  it('fails loudly when check:standards is red but no error names any survivor (never silently lands unvalidated)', async () => {
    const MYSTERY_RED = JSON.stringify({ ok: false, errors: [{ message: 'some unrelated repo-wide error' }] });
    const { exec, calls } = scriptedExec([ACQUIRE_OK, 'added', MYSTERY_RED, 'released']);
    const result = await sweepOrphanBacklogCards({ clone: '/clone', session: 's' }, {
      exec, write: () => {}, listOrphans: () => ONE_CARD(), readMain: () => ({ mainBornAsIds: new Set(), mainGuardKeys: new Set() }),
      mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.step).toBe('content-check');
    expect(calls.some((c) => c.args.includes('commit'))).toBe(false);
  });
});

describe('parseSweepArgv', () => {
  it('requires --clone, defaults session + dry-run', () => {
    expect(() => parseSweepArgv([])).toThrow(/--clone=/);
    const parsed = parseSweepArgv(['--clone=/workspace/wev-review-daemon']);
    expect(parsed.clone).toBe('/workspace/wev-review-daemon');
    expect(parsed.session).toMatch(/^orphan-card-sweep-/);
    expect(parsed.dryRun).toBe(false);
  });

  it('reads an explicit session and dry-run flag', () => {
    const parsed = parseSweepArgv(['--clone=/c', '--session=my-session', '--dry-run=true']);
    expect(parsed.session).toBe('my-session');
    expect(parsed.dryRun).toBe(true);
  });
});

describe('runSweepOrphanBacklogCardsCli', () => {
  it('exits 1 with no sweep call at all on a missing --clone', async () => {
    let sweepCalled = false;
    const { code } = await runSweepOrphanBacklogCardsCli([], {
      sweep: () => { sweepCalled = true; }, write: () => {}, writeErr: () => {},
    });
    expect(code).toBe(1);
    expect(sweepCalled).toBe(false);
  });

  it('exits 0 and reports counts on a successful sweep', async () => {
    const { code, result } = await runSweepOrphanBacklogCardsCli(['--clone=/c'], {
      sweep: async () => ({ ok: true, step: 'done', reason: null, landed: ['a', 'b'], dropped: ['c'], pr: 42, url: 'u' }),
      write: () => {}, writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(result.pr).toBe(42);
  });

  it('exits 1 on a failed sweep', async () => {
    const { code } = await runSweepOrphanBacklogCardsCli(['--clone=/c'], {
      sweep: async () => ({ ok: false, step: 'verify', reason: 'gate red', landed: [], dropped: [] }),
      write: () => {}, writeErr: () => {},
    });
    expect(code).toBe(1);
  });
});
