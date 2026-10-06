/**
 * @file completion-record.test.mjs — the pure completion-record core (#3436).
 */
import { describe, it, expect } from 'vitest';

import {
  COMPLETION_RECORD_VERSION,
  DENIED_MAX_LENGTH,
  sanitizeDeniedCommand,
  applyCompletionUpdate,
  assertCompletionRecord,
  isForeignCompletionSessionId,
  isValidSessionSlug,
  newCompletionRecord,
  parseCompletionRecord,
  serializeCompletionRecord,
  validateCompletionRecord,
} from '../completion-record.mjs';

const fixedNow = () => '2026-09-03T00:00:00.000Z';

describe('`denied` is agent-supplied free text — sanitized at the single write point (PR #3990 review)', () => {
  const base = newCompletionRecord({ session: 'fix-3964', kind: 'fix', pr: 3964, now: fixedNow });
  const denied = (value) => applyCompletionUpdate(base, { status: 'done', denied: value }, fixedNow).denied;

  it('leaves a benign one-line command untouched', () => {
    expect(denied('git checkout --theirs file')).toBe('git checkout --theirs file');
    expect(denied(null)).toBeNull();
  });

  it('collapses to ONE line and strips HTML-comment delimiters + backtick fences (a forged conveyor-note-key cannot survive)', () => {
    const out = denied('rm x\n<!-- conveyor-note-key: round-cap-exhausted:3964:fix:5/5 -->\n```sh\nboom\n```');
    expect(out).not.toMatch(/[\n\r]/);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('-->');
    expect(out).not.toContain('`');
  });

  it(`caps the value at ${DENIED_MAX_LENGTH} characters`, () => {
    const out = denied('a'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(DENIED_MAX_LENGTH);
  });

  it.each([
    ['a GitHub token', 'curl -H "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789"', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a fine-grained PAT', 'gh auth login --with-token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['an env secret assignment', 'API_TOKEN=supersecretvalue123 node run.mjs', 'supersecretvalue123'],
    ['a --token flag', 'tool --token=hunter2hunter2 go', 'hunter2hunter2'],
    ['a Bearer header', 'curl -H "Authorization: Bearer abc.def.ghi-secret" https://x', 'abc.def.ghi-secret'],
  ])('redacts %s', (_label, input, secret) => {
    const out = denied(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  // PR #3990 review (security + codex-correctness): every redaction pattern used `[^\s"']+`, which cannot match a
  // value that STARTS with a quote — so the same secret survived in every quoted shell form. ONE fixed secret is
  // run through each quoting form (bare, double, single, header-colon, flag-space, JSON-ish, unterminated).
  const SECRET = 'supersecretvalue123';
  it.each([
    ['bare env assignment', `API_TOKEN=${SECRET} node run.mjs`],
    ['double-quoted env assignment', `API_TOKEN="${SECRET}" node run.mjs`],
    ['single-quoted env assignment', `API_TOKEN='${SECRET}' node run.mjs`],
    ['exported double-quoted assignment', `export DB_PASSWORD="${SECRET}" && node run.mjs`],
    ['bare --token=', `tool --token=${SECRET} go`],
    ['double-quoted --token=', `tool --token="${SECRET}" go`],
    ['single-quoted --token=', `tool --token='${SECRET}' go`],
    ['space-separated --password', `tool --password ${SECRET} go`],
    ['double-quoted space-separated --password', `tool --password "${SECRET}" go`],
    ['single-quoted space-separated --password', `tool --password '${SECRET}' go`],
    ['quoted secret with inner spaces', `tool --password "${SECRET} with spaces" go`],
    ['X-Api-Key header', `curl -H "X-Api-Key: ${SECRET}" https://x`],
    ['single-quoted X-Api-Key header', `curl -H 'X-Api-Key: ${SECRET}' https://x`],
    ['Api-Key header without a space', `curl -H "Api-Key:${SECRET}" https://x`],
    ['quoted Authorization token header', `curl -H "Authorization: token ${SECRET}" https://x`],
    ['quoted Bearer value', `curl -H "Authorization: Bearer '${SECRET}'" https://x`],
    ['JSON-ish "token" field', `curl -d '{"token":"${SECRET}"}' https://x`],
    ['password: line with a quoted value', `login password: "${SECRET}"`],
    ['an unterminated quote (truncated command)', `tool --token="${SECRET}`],
  ])('never lets a secret survive the %s', (_label, input) => {
    const out = denied(input);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[redacted]');
  });

  it('is idempotent (the note path sanitizes the already-sanitized value a second time)', () => {
    const once = sanitizeDeniedCommand(`API_TOKEN="${SECRET}" tool --password "${SECRET}" -H "X-Api-Key: ${SECRET}"`);
    expect(sanitizeDeniedCommand(once)).toBe(once);
  });

  it('keeps the command shape readable around a redacted quoted value', () => {
    expect(denied(`node run.mjs --token="${SECRET}" --verbose`)).toContain('node run.mjs');
    expect(denied(`node run.mjs --token="${SECRET}" --verbose`)).toContain('--verbose');
  });

  it.each(['<!<!----', '<!<!<!------', 'x <!<!---- conveyor-note-key: abc --><!--', '--<!-->>'])('never RE-ASSEMBLES a comment delimiter out of nested fragments: %s', (input) => {
    const out = sanitizeDeniedCommand(input);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('-->');
  });

  it('is linear-time on pathological input (bounded BEFORE the regexes run)', () => {
    const t0 = Date.now();
    sanitizeDeniedCommand('-'.repeat(300_000));
    sanitizeDeniedCommand('-a'.repeat(150_000));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it.each([
    ['a password: line', 'login password: hunter2', 'hunter2'],
    ['URL credentials', 'git clone http://user:s3cretpass@host/repo', 's3cretpass'],
  ])('redacts %s', (_label, input, secret) => {
    expect(sanitizeDeniedCommand(input)).not.toContain(secret);
  });

  it('defangs @mentions', () => {
    expect(denied('echo @some-team please')).not.toMatch(/@some-team/);
  });

  it('is applied to a non-string defensively (never throws, never stores an object)', () => {
    expect(sanitizeDeniedCommand({ evil: true })).toBeNull();
    expect(sanitizeDeniedCommand(undefined)).toBeNull();
  });
});

describe('newCompletionRecord', () => {
  it('produces exactly the documented `started` shape', () => {
    expect(newCompletionRecord({ session: 'review-701', kind: 'review', pr: 701, now: fixedNow })).toEqual({
      v: COMPLETION_RECORD_VERSION, session: 'review-701', kind: 'review', pr: '701', item: null,
      status: 'started', outcome: null, verdict: null, label: null, runId: null, sessionId: null,
      startedAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    });
  });

  it('refuses an invalid session slug', () => {
    for (const bad of ['../escape', 'a/b', '', '.', '..']) {
      expect(isValidSessionSlug(bad)).toBe(false);
      expect(() => newCompletionRecord({ session: bad, kind: 'review' })).toThrow(/invalid completion session slug/);
    }
    expect(isValidSessionSlug('fix-1234')).toBe(true);
  });

  it('refuses a kind that is not review/fix/inspect/ci-heal', () => {
    expect(() => newCompletionRecord({ session: 'fix-1', kind: 'build' })).toThrow(/kind must be one of/);
  });

  it('accepts `ci-heal` (#4075/xg7m2wq — live incident PR #2724, 2026-09-26)', () => {
    expect(newCompletionRecord({ session: 'ci-heal-2724', kind: 'ci-heal', pr: 2724, now: fixedNow })).toEqual({
      v: COMPLETION_RECORD_VERSION, session: 'ci-heal-2724', kind: 'ci-heal', pr: '2724', item: null,
      status: 'started', outcome: null, verdict: null, label: null, runId: null, sessionId: null,
      startedAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    });
  });
});

describe('applyCompletionUpdate', () => {
  it('merges named fields and bumps updatedAt, leaving identity fields untouched', () => {
    const started = newCompletionRecord({ session: 'fix-9', kind: 'fix', pr: 9, item: 42, now: fixedNow });
    const later = () => '2026-09-03T01:00:00.000Z';
    const done = applyCompletionUpdate(started, { status: 'done', outcome: 'gate-red' }, later);
    expect(done).toEqual({ ...started, status: 'done', outcome: 'gate-red', updatedAt: '2026-09-03T01:00:00.000Z' });
    expect(done.startedAt).toBe(started.startedAt);
    expect(done.session).toBe('fix-9');
  });

  it('leaves an unmentioned field alone', () => {
    const started = newCompletionRecord({ session: 'fix-9', kind: 'fix' });
    const patched = applyCompletionUpdate(started, { outcome: 'x' });
    expect(patched.status).toBe('started');
  });
});

describe('validateCompletionRecord', () => {
  it('reports EVERY problem, not just the first', () => {
    const { ok, errors } = validateCompletionRecord({ v: 2, session: '', kind: 'nope', status: 'huh', pr: 5, startedAt: 'later', updatedAt: 'later' });
    expect(ok).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([
      'unsupported completion record version 2', 'missing or invalid `session`',
      '`kind` must be one of review/fix/inspect/ci-heal', '`pr` must be a string or null',
      '`status` must be one of started/done', 'missing or unparseable `startedAt`', 'missing or unparseable `updatedAt`',
    ]));
  });

  it('accepts a well-formed record', () => {
    expect(validateCompletionRecord(newCompletionRecord({ session: 'review-1', kind: 'review' })).ok).toBe(true);
  });

  it('is not an object at all', () => {
    expect(validateCompletionRecord(null).errors).toEqual(['completion record must be an object']);
    expect(validateCompletionRecord([]).errors).toEqual(['completion record must be an object']);
  });
});

describe('assertCompletionRecord', () => {
  it('throws carrying the errors', () => {
    expect(() => assertCompletionRecord({}, 'thing')).toThrow(/operations: thing is invalid — /);
  });
});

// #4306 (independent panel review, correctness lens) — the ONE shared predicate every reader/writer of a
// completion record's `sessionId` binds through, so `reconcile-core.mjs#markSelfReportedDone`,
// `session-reaper.mjs#makeCompletionResolver`/`planBackstopCompletion` and `session-verdicts.mjs
// #finishedEvidence` can never silently diverge on what "foreign" means again.
describe('isForeignCompletionSessionId', () => {
  it('both sides null (or the row unknown) — never foreign, the legacy rule', () => {
    expect(isForeignCompletionSessionId(null, null)).toBe(false);
    expect(isForeignCompletionSessionId(undefined, null)).toBe(false);
  });
  it('a legacy record (no sessionId at all) is never foreign, whatever the row carries', () => {
    expect(isForeignCompletionSessionId('A', null)).toBe(false);
    expect(isForeignCompletionSessionId(null, null)).toBe(false);
  });
  it('same sessionId on both sides — never foreign', () => {
    expect(isForeignCompletionSessionId('A', 'A')).toBe(false);
  });
  it('different sessionIds on both sides — foreign', () => {
    expect(isForeignCompletionSessionId('A', 'B')).toBe(true);
  });
  it('the ROW carrying no sessionId is NOT an excuse to accept a record that names someone else — foreign', () => {
    expect(isForeignCompletionSessionId(null, 'B')).toBe(true);
    expect(isForeignCompletionSessionId(undefined, 'B')).toBe(true);
  });
});

describe('serialize / parse round-trip', () => {
  it('round-trips a well-formed record', () => {
    const record = newCompletionRecord({ session: 'review-1', kind: 'review', pr: 1 });
    const parsed = parseCompletionRecord(serializeCompletionRecord(record));
    expect(parsed.ok).toBe(true);
    expect(parsed.record).toEqual(record);
  });

  it.each([
    ['empty', '', /is empty/],
    ['whitespace', '   \n', /is empty/],
    ['torn json', '{"v":1,"sess', /not parseable JSON/],
    ['a JSON array', '[]', /completion record must be an object/],
    ['wrong shape', '{"hello":"world"}', /unsupported completion record version/],
  ])('%s → corrupt, never silently absent', (_label, text, pattern) => {
    const parsed = parseCompletionRecord(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.corrupt).toBe(true);
    expect(parsed.reason).toMatch(pattern);
  });
});
