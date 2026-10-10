import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readQuarantine, writeQuarantineChange } from '../red-main-quarantine-io.mjs';
import { addEntries, pruneOnGreen, testsToSkip } from '../red-main-quarantine.mjs';

const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'rmq-'));
  const origin = join(d, 'origin.git');
  g(['init', '--quiet', '--bare', origin], d);
  const board = join(d, 'board');
  g(['clone', '--quiet', origin, board], d);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'init'], board);
  g(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], board);
  g(['config', 'user.email', 't@t'], board); g(['config', 'user.name', 't'], board);
  return { origin, board };
}
const SHA = '7e51376635bbb571dfc596f1986960bf35a03fd6';
const TEST = 'skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs';

describe('quarantine IO — ops/quarantine branch (real git)', () => {
  it('an unreachable branch is unreadable, never empty', () => {
    const { board } = repo();
    expect(readQuarantine({ board }).ok).toBe(false);
  });
  it('add creates ops/quarantine with the list + an audit event; prune on green empties it; nothing else is pushed', () => {
    const { board, origin } = repo();
    const now = Date.now();
    writeQuarantineChange({ board, actor: 'red-main-safety-net', message: 'add', change: (cur) => addEntries(cur, { tests: [TEST], brokenSha: SHA, owner: 'o', reason: 'r', actor: 'red-main-safety-net', now }) });
    const r = readQuarantine({ board });
    expect(r.ok).toBe(true);
    expect(testsToSkip({ list: r.list, now, prNumber: 1, fixPrs: [2] })).toEqual([TEST]);
    const events = g(['show', 'refs/heads/ops/quarantine:events.jsonl'], origin);
    expect(events).toContain('"type":"quarantine-added"');
    writeQuarantineChange({ board, actor: 'red-main-safety-net', message: 'prune', change: (cur) => pruneOnGreen(cur, { mainGreen: true, now }) });
    expect(readQuarantine({ board }).list.entries).toEqual([]);
    expect(g(['show', 'refs/heads/ops/quarantine:events.jsonl'], origin)).toContain('"type":"quarantine-removed"');
    expect(g(['for-each-ref', '--format=%(refname)'], origin).trim().split('\n').sort()).toEqual(['refs/heads/main', 'refs/heads/ops/quarantine']);
  });
  it('a writer outside the allow-list writes nothing', () => {
    const { board, origin } = repo();
    expect(() => writeQuarantineChange({ board, actor: 'pr-4613', message: 'x', change: (cur) => ({ ok: true, list: cur, events: [] }) })).toThrow(/refused/);
    expect(g(['for-each-ref', '--format=%(refname)'], origin).trim()).toBe('refs/heads/main');
  });
});
