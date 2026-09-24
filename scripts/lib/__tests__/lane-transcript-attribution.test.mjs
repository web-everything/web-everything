/**
 * @file scripts/lib/__tests__/lane-transcript-attribution.test.mjs
 * @description Proof of #3383's "EXACT ATTRIBUTION FROM TRANSCRIPTS" ask: a session that wrote exactly the
 * files sitting uncommitted in a lane is findable from its own JSONL transcript, and ranks ABOVE a session
 * that merely `cd`ed through the lane. `scanLaneTranscripts` does this in ONE grep pass for every lane at once
 * (never one grep per lane) via an injected `exec`, so no real filesystem/grep/`~/.claude` tree is touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { laneTouchFromLine, summarizeLaneTouches, scanLaneTranscripts } from '../lane-transcript-attribution.mjs';

const LANE = '/Users/x/workspace/.lanes/web-everything/lane-17';

// `scanLaneTranscripts` real-checks `existsSync(root)` before grepping (an absent `~/.claude/projects` tree
// degrades to "no matches" rather than a spawn error) — so its own tests need a REAL directory for `root`,
// even though the grep/read calls themselves are injected fakes that never touch it.
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lane-transcript-root-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const editLine = (sessionId, file_path, ts) => JSON.stringify({
  type: 'assistant', sessionId, timestamp: ts,
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path } }] },
});
const bashLine = (sessionId, command, ts) => JSON.stringify({
  type: 'assistant', sessionId, timestamp: ts,
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});

describe('laneTouchFromLine', () => {
  it('matches an Edit/Write/NotebookEdit whose file_path sits under the lane', () => {
    const t = laneTouchFromLine(editLine('sess-A', `${LANE}/scripts/foo.mjs`, '2026-01-01T00:00:00Z'), LANE);
    expect(t).toEqual({ ts: '2026-01-01T00:00:00Z', sessionId: 'sess-A', tool: 'Edit', path: `${LANE}/scripts/foo.mjs` });
  });

  it('matches a Bash command that mentions the lane path (a cd, or an absolute-path op)', () => {
    const t = laneTouchFromLine(bashLine('sess-B', `cd ${LANE} && git status`, '2026-01-01T00:01:00Z'), LANE);
    expect(t.tool).toBe('Bash');
    expect(t.path).toBeNull();
  });

  it('ignores a file_path OUTSIDE this lane (a different lane, or the primary checkout)', () => {
    expect(laneTouchFromLine(editLine('sess-A', '/Users/x/workspace/.lanes/web-everything/lane-9/foo.mjs', 't'), LANE)).toBeNull();
  });

  it('returns null for a non-assistant line, and never throws on unparsable JSON', () => {
    expect(laneTouchFromLine('{"type":"user"}', LANE)).toBeNull();
    expect(laneTouchFromLine('not json at all', LANE)).toBeNull();
  });
});

describe('summarizeLaneTouches', () => {
  it('ranks the session whose edited files match the lane\'s actual dirty paths ABOVE one that only cd\'d through', () => {
    const touches = [
      laneTouchFromLine(bashLine('sess-cd-only', `cd ${LANE} && ls`, '2026-01-01T00:00:00Z'), LANE),
      laneTouchFromLine(editLine('sess-writer', `${LANE}/scripts/real-work.mjs`, '2026-01-02T00:00:00Z'), LANE),
    ];
    const rows = summarizeLaneTouches(touches, LANE, ['scripts/real-work.mjs']);
    expect(rows[0].sessionId).toBe('sess-writer');
    expect(rows[0].coverage).toBe(1);
    expect(rows.find((r) => r.sessionId === 'sess-cd-only').coverage).toBe(0);
  });

  it('breaks a coverage tie by recency (the LATER write wins)', () => {
    const touches = [
      laneTouchFromLine(editLine('sess-early', `${LANE}/a.mjs`, '2026-01-01T00:00:00Z'), LANE),
      laneTouchFromLine(editLine('sess-late', `${LANE}/a.mjs`, '2026-01-02T00:00:00Z'), LANE),
    ];
    const rows = summarizeLaneTouches(touches, LANE, ['a.mjs']);
    expect(rows[0].sessionId).toBe('sess-late');
  });
});

describe('scanLaneTranscripts', () => {
  it('greps the whole tree ONCE for every lane at once, then parses only matching files', () => {
    const calls = [];
    const exec = (file, args) => { calls.push({ file, args }); return `${'/root/a.jsonl'}\n${'/root/b.jsonl'}\n`; };
    const read = (path) => {
      if (path === '/root/a.jsonl') return `${editLine('sess-1', `${LANE}/x.mjs`, 't1')}\n`;
      return `${editLine('sess-2', '/Users/x/workspace/.lanes/web-everything/lane-9/y.mjs', 't2')}\n`;
    };
    const result = scanLaneTranscripts(root, { 17: LANE, 9: '/Users/x/workspace/.lanes/web-everything/lane-9' }, { exec, read });
    expect(calls).toHaveLength(1); // ONE grep call for both lanes
    expect(result.get('17')).toHaveLength(1);
    expect(result.get('17')[0].sessionId).toBe('sess-1');
    expect(result.get('9')).toHaveLength(1);
    expect(result.get('9')[0].sessionId).toBe('sess-2');
  });

  it('degrades to empty maps when grep fails or finds nothing — never throws', () => {
    const exec = () => { const e = new Error('no matches'); e.status = 1; throw e; };
    const result = scanLaneTranscripts(root, { 17: LANE }, { exec, read: () => '' });
    expect(result.get('17')).toEqual([]);
  });

  it('returns an empty map for no lanes requested, without calling exec at all', () => {
    let called = false;
    const exec = () => { called = true; return ''; };
    const result = scanLaneTranscripts(root, {}, { exec });
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });
});
