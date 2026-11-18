/**
 * @file scripts/__tests__/learnings-drop.test.mjs
 * @description Unit proof of the delivery-agent learnings drop-box (#2614): the schema is TENANT-READY —
 *   generalized-lesson fields only — and the write is GATED (#883 write-time-gate precedent). A valid entry
 *   passes; an entry carrying an absolute path, a token-shaped string, or a code block is REJECTED and never
 *   appended. Also pins the allow-list (an out-of-schema field can't smuggle a leak) and the append round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KINDS, ALLOWED_KEYS, FIELD_CAPS, PROPOSED_FIX_CAP, scrubReasons, isHighEntropyToken, validateEntry, appendEntry,
  resolveDropboxPath, poolDir, normalizeTs, OPTIONAL_HICCUP_KEYS,
} from '../conveyor/learnings-drop.mjs';

const good = {
  kind: 'friction',
  summary: 'the lane gate re-runs the whole suite even for a docs-only diff',
  area: 'lane gating / check:standards',
  suggestion: 'scope the lane gate to the touched file-families',
};

describe('validateEntry — happy path', () => {
  it('accepts a well-formed generalized-lesson entry', () => {
    const r = validateEntry(good);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.clean).toEqual({ ...good, ts: null });
  });
  it('accepts every declared kind', () => {
    for (const kind of KINDS) expect(validateEntry({ ...good, kind }).ok).toBe(true);
  });
});

describe('validateEntry — `ts` goes through the boundary too (no raw re-attach downstream)', () => {
  it('normalizes a strict ISO stamp through to `clean`', () => {
    expect(validateEntry({ ...good, ts: '2026-08-01T00:00:00.000Z' }).clean.ts).toBe('2026-08-01T00:00:00.000Z');
    expect(validateEntry({ ...good, ts: '2026-08-01T00:00:00Z' }).clean.ts).toBe('2026-08-01T00:00:00Z');
  });
  it('nulls ANY non-ISO `ts` rather than passing the payload through — one bad stamp costs only its own entry', () => {
    // The hostile case: a hand-written line whose `ts` is a payload. It used to reach `stats.oldest` intact
    // (sorted first because it starts below '2') and be printed verbatim by `--json`.
    expect(validateEntry({ ...good, ts: '!!! <script>alert(1)</script>' }).clean.ts).toBeNull();
    // The everyday case: a half-written or hand-edited stamp.
    expect(validateEntry({ ...good, ts: '2026-08-01' }).clean.ts).toBeNull();
    expect(validateEntry({ ...good, ts: 'Aug 1 2026' }).clean.ts).toBeNull();
    expect(validateEntry({ ...good, ts: 1754006400000 }).clean.ts).toBeNull();
    // ISO SHAPE but not a real instant — shape alone is not enough.
    expect(validateEntry({ ...good, ts: '2026-13-45T99:99:99Z' }).clean.ts).toBeNull();
  });
  it('normalizeTs is total — never throws on any input', () => {
    for (const v of [undefined, null, 0, {}, [], 'x']) expect(normalizeTs(v)).toBeNull();
  });
});

// ── #3015: the content scrub MOVED OFF this seam ─────────────────────────────────────────────────
// These cases used to assert `validateEntry` REJECTS each shape. They are kept — not deleted — and
// inverted, because the inversion IS the behaviour change and it must be visible in the suite. The pool
// file is machine-local and untracked; the gate that matters now stands at the publish seam
// (`scrubPublish`, proven end-to-end in publish-secret-gate.test.mjs). Say it plainly: a secret-shaped
// value now LANDS in the local pool and is READ by the harvest — it is blocked from being COMMITTED.
describe('validateEntry — the content scrub no longer runs here (#3015)', () => {
  it('ACCEPTS an entry carrying an ABSOLUTE path', () => {
    const r = validateEntry({ ...good, area: 'the file /Users/nic/workspace/we/scripts/foo.mjs' });
    expect(r.ok).toBe(true);
  });
  it('ACCEPTS an entry carrying a TOKEN-shaped string — the pool is not the boundary any more', () => {
    const r = validateEntry({ ...good, suggestion: 'rotate the leaked key gh\x70_ABCDEFabcdef0123456789ABCDEF01234567' });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it('ACCEPTS an entry carrying a CODE block', () => {
    expect(validateEntry({ ...good, summary: 'saw this ```js\nconst x = 1;\n``` fail' }).ok).toBe(true);
  });
  it('ACCEPTS a home-relative (~/) absolute path', () => {
    expect(validateEntry({ ...good, area: 'lives under ~/workspace/we/scripts' }).ok).toBe(true);
  });
  it('ACCEPTS a long base64/hex blob', () => {
    expect(validateEntry({ ...good, suggestion: 'value was deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }).ok).toBe(true);
  });
  it('the detector itself still WORKS — it is unwired here, not broken', () => {
    // If this ever goes green-by-vacuity (the scrub deleted rather than relocated), the publish seam has
    // nothing to call. `scrubReasons` is still exported from this module for exactly that reason.
    expect(scrubReasons('rotate gh\x70_ABCDEFabcdef0123456789ABCDEF01234567').length).toBeGreaterThan(0);
  });
  it('the SCHEMA half of the boundary is untouched — caps and allow-list still reject', () => {
    expect(validateEntry({ ...good, area: 'x'.repeat(FIELD_CAPS.area + 1) }).ok).toBe(false);
    expect(validateEntry({ ...good, secretField: 'anything' }).ok).toBe(false);
  });
});

describe('validateEntry — schema is the privacy boundary', () => {
  it('rejects a key outside the allow-list (no smuggling a `path`/`code` field)', () => {
    const r = validateEntry({ ...good, path: '/Users/nic/secret', code: 'const s = process.env.SECRET' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/disallowed field/i);
  });
  it('exposes exactly the generalized-lesson keys plus the #3421 hiccup keys and the #3016 grounding keys', () => {
    // blocking / proposedFix / approvalPending are OPTIONAL and hiccup-only (see the #3421 describe block
    // below) — their presence in the allow-list does not widen what a non-blocking entry may carry.
    // quotedTurn / transcript are the OPTIONAL grounding pair (see the #3016 describe block below).
    expect(ALLOWED_KEYS).toEqual([
      'kind', 'summary', 'area', 'suggestion', 'blocking', 'proposedFix', 'approvalPending', 'quotedTurn', 'transcript',
    ]);
  });
  it('rejects an unknown kind, a missing field, and a non-object', () => {
    expect(validateEntry({ ...good, kind: 'bug' }).ok).toBe(false);
    expect(validateEntry({ ...good, summary: '' }).ok).toBe(false);
    expect(validateEntry(null).ok).toBe(false);
    expect(validateEntry([good]).ok).toBe(false);
  });
});

describe('scrubReasons — clean text passes', () => {
  it('returns no reasons for a plain generalized sentence', () => {
    expect(scrubReasons('the lane gate is too coarse for docs-only diffs')).toEqual([]);
  });
  it('flags an absolute path and a code fence', () => {
    expect(scrubReasons('/etc/passwd was read').length).toBeGreaterThan(0);
    expect(scrubReasons('```bash\nrm -rf\n```').length).toBeGreaterThan(0);
  });
});

// ── review-round red-team fixtures: every confirmed bypass must now be REJECTED ──────────────────
describe('scrub — closes the audited bypasses (must reject)', () => {
  const reject = (v) => expect(scrubReasons(v).length, `should reject: ${v}`).toBeGreaterThan(0);
  it('1. Google API key class (AIza…, no known prefix rule caught it)', () => {
    reject('leaked AIzaSyD1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT today');
  });
  it('2. URL with inline credentials (glued // dodged the path rule)', () => {
    reject('connect via https://admin:hunter2Trombone@db.internal');
  });
  it('3. repo-identifying relative + repo-relative source paths', () => {
    reject('see ../../webeverything/src/lane-board.ts for the bug');
    reject('the file src/backlog-view/lane-board.ts is wrong');
  });
  it('4. single-line code and one-liner SQL', () => {
    reject("const x = fetch('/api/users')");
    reject('SELECT * FROM users WHERE id = 1');
  });
  it('5. bare high-entropy token (unknown format, no prefix)', () => {
    reject('the value was abcdEFGH1234abcdEFGH somewhere');
  });
  it('6. email and IPs (PII for the downstream telemetry seam)', () => {
    reject('ping nic.g.gilbert@gmail.com about it');
    reject('the host at 10.0.0.5 was unreachable');
    reject('bind fe80:0:0:0:0:0:0:1 failed');
  });
  it('labeled credential with a secret-shaped value', () => {
    reject('password: hunter2Trombone was committed');
  });
});

// ── critical balance: domain vocabulary of THIS web-standards repo must PASS ───────────────────────
describe('scrub — domain vocabulary must NOT be rejected (must pass)', () => {
  const pass = (v) => expect(scrubReasons(v), `should pass: ${v}`).toEqual([]);
  it('7a. a bare web-component element name', () => pass('the <select> element needs an aria-label default'));
  it('7b. bare <dialog>/<slot> element names', () => pass('a <dialog> should trap focus and a <slot> should forward it'));
  it('7c. "token:" as prose, not a credential', () => pass('the session token: often expires mid long run'));
  it('7d. scope: [] and check:standards vocabulary', () => {
    pass('an empty scope: [] should still acquire the whole lane');
    pass('the check:standards gate must stay green before landing');
  });
  it('a bare AGENTS.md mention (name, not a path) passes', () => pass('the AGENTS.md router omits the conveyor pointer'));
});

// ── round-3 review: three MORE single-value bypasses (each a complete secret/path in one field) ──────
describe('scrub — round-3 audited bypasses (must reject)', () => {
  const reject = (v) => expect(scrubReasons(v).length, `should reject: ${v}`).toBeGreaterThan(0);
  it('1. GitHub fine-grained PAT (internal _ defeated the base64 \\b; >40 chars skipped entropy)', () => {
    reject('rotate github_\x70at_11ABCDEFG0aZ1bY2cX3dW4eV5fU6gT7hS8iR9jQ0kP1lO2mN3');
  });
  it('2. absolute/home paths glued to a non-space char (=, quote, paren)', () => {
    reject('path=/Users/nic/workspace/foo');
    reject('the value "/Users/nic/workspace/foo" here');
    reject('see (/Users/nic/workspace/foo) now');
    reject('home=~/workspace/webeverything/scripts');
  });
  it('3. two-class opaque tokens 16–31 chars (base32 TOTP + 20-char hex session id)', () => {
    reject('the secret jbswy3dpehpk3pxpjbswy3dp leaked');   // base32 TOTP, low vowel ratio
    reject('session a3f9c1e8b7d2f6a0c4e1 expired');          // 20-char lowercase hex
    reject('code JBSWY3DPEHPK3PXP now');                     // 16-char base32 upper
  });
});

describe('scrub — round-3 false-positive-risk cases (must pass)', () => {
  const pass = (v) => expect(scrubReasons(v), `should pass: ${v}`).toEqual([]);
  it('git SHORT shas in prose (≤12 hex) pass; only long/opaque runs reject', () => {
    pass('landed in abc1234 yesterday');
    pass('landed in a3f9c1e8b7d2 today'); // 12-char hex short sha
  });
  it('a hex color passes', () => pass('use #a3f9c1 for the border'));
  it('word-concatenation identifiers pass despite mixed 2-class shape', () => {
    pass('see item2614dropbox for the fixture');       // 2-class, vowel ratio ~0.36
    pass('lane5poolacquire is the helper');            // 2-class, vowel ratio ~0.53
    pass('tag webeverything2024 release');             // 2-class + repo name, but not a path
    pass('workflowprogress2 heartbeat block');
    pass('the backlogworkflowworkflow module split');  // single-case long identifier
  });
  it('a 20-char kebab slug passes', () => pass('the my-cool-feature-slug branch'));
});

describe('isHighEntropyToken — catches opaque keys, spares identifiers', () => {
  it('rejects a mixed-class medium blob (shape a)', () => {
    expect(isHighEntropyToken('abcdEFGH1234abcdEFGH')).toBe(true);
  });
  it('rejects a non-pronounceable low-vowel token (shape b) and a long PAT (>40)', () => {
    expect(isHighEntropyToken('jbswy3dpehpk3pxpjbswy3dp')).toBe(true);  // base32 TOTP
    expect(isHighEntropyToken('github_\x70at_11ABCDEFG0aZ1bY2cX3dW4eV5fU6gT7hS8iR9jQ0kP1lO2mN3')).toBe(true);
  });
  it('passes ordinary single-case identifiers and short tokens', () => {
    expect(isHighEntropyToken('batch-backlog-items')).toBe(false); // single case / hyphen, pronounceable
    expect(isHighEntropyToken('closingSession')).toBe(false);      // too short (<16)
    expect(isHighEntropyToken('check')).toBe(false);               // too short
    expect(isHighEntropyToken('lane5poolacquire')).toBe(false);    // 16 chars, 2-class, but pronounceable (vowel ratio spares it)
  });
});

describe('field length caps — structural leak-class kill (review fix A)', () => {
  it('rejects an over-length summary / area / suggestion', () => {
    expect(validateEntry({ ...good, summary: 'x '.repeat(FIELD_CAPS.summary) }).ok).toBe(false);
    expect(validateEntry({ ...good, area: 'a '.repeat(FIELD_CAPS.area) }).ok).toBe(false);
    expect(validateEntry({ ...good, suggestion: 's '.repeat(FIELD_CAPS.suggestion) }).ok).toBe(false);
  });
  it('caps are summary 240 / area 60 / suggestion 400', () => {
    // proposedFix's cap is DELIBERATELY not in FIELD_CAPS (see PROPOSED_FIX_CAP below) — a consumer that
    // iterates FIELD_CAPS treats every key as a field REQUIRED on every entry (scripts/lib/review-loop-policy.mjs),
    // and proposedFix is optional (blocking entries only).
    expect(FIELD_CAPS).toEqual({ summary: 240, area: 60, suggestion: 400 });
  });
  it('proposedFix has its own 400-char cap, kept OUT of FIELD_CAPS on purpose', () => {
    expect(PROPOSED_FIX_CAP).toBe(400);
    expect(FIELD_CAPS).not.toHaveProperty('proposedFix');
  });
});

describe('appendEntry — write round-trip', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'learnings-drop-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('appends a validated entry as one JSONL line with a ts stamp, and stays append-only', () => {
    const file = join(root, 'box.jsonl');
    const a = appendEntry(good, { file, root, now: '2026-07-22T10:00:00Z' });
    expect(a.path).toBe(file);
    expect(a.record.ts).toBe('2026-07-22T10:00:00.000Z');
    appendEntry({ ...good, kind: 'doc-gap' }, { file, root });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject(good);
    expect(Object.keys(first).sort()).toEqual(['area', 'kind', 'suggestion', 'summary', 'ts']);
  });

  it('THROWS and does NOT create the file when the entry is rejected', () => {
    // #3015: the rejection driver is now a SCHEMA violation (an out-of-allow-list key), not a secret in a
    // value — a secret no longer fails validation here. The reject-before-write SHAPE is what this pins,
    // and that shape is unchanged.
    const file = join(root, 'never.jsonl');
    expect(() => appendEntry({ ...good, diff: 'a smuggled field' }, { file, root })).toThrow(/rejected/);
    expect(existsSync(file)).toBe(false);
  });
});

describe('resolveDropboxPath — precedence', () => {
  it('prefers --file, then env, then the session file inside the machine pool', () => {
    expect(resolveDropboxPath({ file: '/x/y.jsonl' })).toBe('/x/y.jsonl');
    expect(resolveDropboxPath({ env: { LEARNINGS_DROPBOX: '/e/box.jsonl' } })).toBe('/e/box.jsonl');
    const p = resolveDropboxPath({ session: 'sess/weird id', env: {}, home: '/home/u' });
    expect(p).toBe('/home/u/.claude/conveyor/learnings/sess-weird-id.jsonl');
  });
});

describe('poolDir — ONE pool per machine, not one per working copy', () => {
  it('is home-anchored, so a lane clone and the primary checkout resolve to the SAME pool', () => {
    // The regression this pins: the old resolver used `git rev-parse --show-toplevel`, so a delivery agent
    // in a lane clone appended somewhere the primary checkout's harvest could never see.
    expect(poolDir({ env: {}, home: '/home/u' })).toBe('/home/u/.claude/conveyor/learnings');
    expect(poolDir({ env: { HOME: '/home/u' } })).toBe('/home/u/.claude/conveyor/learnings');
  });
  it('$LEARNINGS_POOL is the single override', () => {
    expect(poolDir({ env: { LEARNINGS_POOL: '/env/pool' }, home: '/home/u' })).toBe('/env/pool');
  });
});

describe('the session slug is REQUIRED — a shared default file would collapse every session into one', () => {
  it('refuses to resolve a drop-box path with no slug', () => {
    expect(() => resolveDropboxPath({ env: {}, home: '/home/u' })).toThrow(/--session=<slug> is required/);
    expect(() => resolveDropboxPath({ session: '   ', env: {}, home: '/home/u' })).toThrow(/required/);
  });
  it('accepts $LEARNINGS_SESSION as the slug source', () => {
    expect(resolveDropboxPath({ env: { LEARNINGS_SESSION: 'conveyor-2614' }, home: '/home/u' }))
      .toBe('/home/u/.claude/conveyor/learnings/conveyor-2614.jsonl');
  });
  it('an explicit --file still needs no slug (the caller named the target)', () => {
    expect(resolveDropboxPath({ file: '/x/y.jsonl', env: {} })).toBe('/x/y.jsonl');
  });
  it('appendEntry surfaces the refusal rather than writing to a shared default', () => {
    expect(() => appendEntry(good, { env: {}, home: '/home/u' })).toThrow(/--session=<slug> is required/);
  });
});

describe('validateEntry — the #3421 blocking/proposedFix/approvalPending fields (OPTIONAL, hiccup-only)', () => {
  it('a non-blocking entry (no blocking field) is byte-identical to the pre-#3421 clean shape', () => {
    // Pins the backward-compat guarantee: adding the hiccup fields must not add stray keys to every OTHER
    // consumer's exact-shape compare (see the happy-path test above using the same `toEqual`).
    const r = validateEntry(good);
    expect(r.clean).toEqual({ ...good, ts: null });
    expect(Object.keys(r.clean)).not.toContain('blocking');
  });

  it('accepts a well-formed blocking entry, stamping approvalPending:true even if omitted', () => {
    const r = validateEntry({ ...good, blocking: true, proposedFix: 'confirm the guard is still legitimate' });
    expect(r.ok).toBe(true);
    expect(r.clean.blocking).toBe(true);
    expect(r.clean.proposedFix).toBe('confirm the guard is still legitimate');
    expect(r.clean.approvalPending).toBe(true);
  });

  it('rejects blocking:true with no proposedFix', () => {
    const r = validateEntry({ ...good, blocking: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/proposedFix is required/);
  });

  it('rejects blocking:true with approvalPending explicitly false — a fresh hiccup is always pending', () => {
    const r = validateEntry({ ...good, blocking: true, proposedFix: 'x', approvalPending: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/approvalPending must be true/);
  });

  it('rejects proposedFix or approvalPending on a non-blocking (or absent-blocking) entry', () => {
    expect(validateEntry({ ...good, proposedFix: 'x' }).ok).toBe(false);
    expect(validateEntry({ ...good, approvalPending: true }).ok).toBe(false);
    expect(validateEntry({ ...good, blocking: false, proposedFix: 'x' }).ok).toBe(false);
  });

  it('rejects a non-boolean blocking value', () => {
    expect(validateEntry({ ...good, blocking: 'yes' }).ok).toBe(false);
  });

  it('enforces the proposedFix length cap like every other text field', () => {
    const r = validateEntry({ ...good, blocking: true, proposedFix: 'x'.repeat(401) });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/proposedFix: too long/);
  });

  it('ALLOWED_KEYS carries the three hiccup keys, and the disallowed-field error still names them', () => {
    for (const k of OPTIONAL_HICCUP_KEYS) expect(ALLOWED_KEYS).toContain(k);
    const r = validateEntry({ ...good, notAField: 1 });
    expect(r.errors.join(' ')).toMatch(/disallowed field "notAField"/);
  });

  it('appendEntry round-trips a blocking entry end to end', () => {
    const root = mkdtempSync(join(tmpdir(), 'learnings-drop-hiccup-'));
    try {
      const file = join(root, 'hiccup.jsonl');
      const { record } = appendEntry(
        { ...good, blocking: true, proposedFix: 'investigate the repeat suppression' },
        { file, root },
      );
      expect(record.blocking).toBe(true);
      expect(record.approvalPending).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('validateEntry — the #3016 grounding pair (quotedTurn + transcript: OPTIONAL, both or neither, uncapped)', () => {
  const grounded = {
    ...good,
    quotedTurn: 'please stop re-running the whole suite for a README edit',
    transcript: '/home/u/.claude/projects/-home-u-we/0b1c2d3e.jsonl',
  };

  it('accepts a grounded entry and carries both fields into `clean`, quote verbatim', () => {
    const r = validateEntry({ ...grounded, quotedTurn: '  please stop re-running\n the whole suite  ' });
    expect(r.ok).toBe(true);
    expect(r.clean.quotedTurn).toBe('  please stop re-running\n the whole suite  ');
    expect(r.clean.transcript).toBe(grounded.transcript);
  });

  it('an ungrounded entry keeps the plain clean shape — no stray grounding keys', () => {
    expect(Object.keys(validateEntry(good).clean)).not.toContain('quotedTurn');
    expect(Object.keys(validateEntry(good).clean)).not.toContain('transcript');
  });

  it('the quote is UNCAPPED — a multi-thousand-char turn is accepted (#2978 Fork 3)', () => {
    expect(validateEntry({ ...grounded, quotedTurn: 'the operator said '.repeat(400) }).ok).toBe(true);
  });

  it('rejects half a pair, in either direction', () => {
    const { transcript, ...quoteOnly } = grounded;
    const { quotedTurn, ...pointerOnly } = grounded;
    expect(validateEntry(quoteOnly).errors.join(' ')).toMatch(/go together/);
    expect(validateEntry(pointerOnly).errors.join(' ')).toMatch(/go together/);
  });

  it('rejects a quote too short to tie the note to any particular moment', () => {
    expect(validateEntry({ ...grounded, quotedTurn: 'yes do it' }).ok).toBe(false);
    expect(validateEntry({ ...grounded, quotedTurn: '   \n  ' }).ok).toBe(false);
    expect(validateEntry({ ...grounded, quotedTurn: 42 }).ok).toBe(false);
  });

  it('rejects a pointer that is relative, not a .jsonl, multi-line, or not a string', () => {
    for (const transcript of ['projects/x.jsonl', '/abs/transcript.txt', '/abs/a.jsonl\n/abs/b.jsonl', '', true]) {
      expect(validateEntry({ ...grounded, transcript }).ok, JSON.stringify(transcript)).toBe(false);
    }
  });

  it('the CLI carries --quoted-turn/--transcript into the pool line (real call path)', () => {
    const pool = mkdtempSync(join(tmpdir(), 'learnings-drop-cli-'));
    try {
      const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'conveyor', 'learnings-drop.mjs');
      const run = (...extra) => spawnSync(process.execPath, [cli, '--kind=friction', `--summary=${good.summary}`,
        `--area=${good.area}`, `--suggestion=${good.suggestion}`, '--session=cli-grounded', '--json', ...extra],
      { encoding: 'utf8', env: { ...process.env, LEARNINGS_POOL: pool, LEARNINGS_DROPBOX: '' } });
      const ok = run(`--quoted-turn=${grounded.quotedTurn}`, `--transcript=${grounded.transcript}`);
      expect(ok.status, ok.stderr).toBe(0);
      const line = JSON.parse(readFileSync(join(pool, 'cli-grounded.jsonl'), 'utf8').trim());
      expect(line).toMatchObject({ quotedTurn: grounded.quotedTurn, transcript: grounded.transcript });
      // Half a pair on the CLI fails loudly — it is not silently dropped into an ungrounded entry.
      const half = run(`--quoted-turn=${grounded.quotedTurn}`);
      expect(half.status).toBe(1);
      expect(half.stdout).toMatch(/go together/);
    } finally {
      rmSync(pool, { recursive: true, force: true });
    }
  });
});
