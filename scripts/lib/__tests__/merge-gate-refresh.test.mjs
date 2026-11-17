import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { planGateRefresh, refreshMergeGateAfterRestamp } from '../merge-gate-refresh.mjs';

const head = 'a'.repeat(40);
const restampedAtMs = Date.parse('2026-11-15T15:58:24Z');
const gate = (extra = {}) => ({ id: 10, name: 'merge-gate', head_sha: head,
  status: 'completed', conclusion: 'failure', started_at: '2026-11-15T15:58:03Z', ...extra });
const plan = checkRuns => planGateRefresh({ checkRuns, head, restampedAtMs });
function fixture(checkRuns = [gate()], liveHead = head, total = checkRuns.length, labels = []) {
  return vi.fn((_file, args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ labels });
    if (args[0] !== 'api') return '';
    if (args[1].includes('/check-runs')) return JSON.stringify({ total_count: total, check_runs: checkRuns });
    return JSON.stringify({ head: { sha: liveHead } });
  });
}
const run = (gh, extra = {}) => refreshMergeGateAfterRestamp({ repo: 'o/r', pr: 7, head, gh,
  restampedAtMs, sleep: vi.fn(), ...extra });
afterEach(() => vi.restoreAllMocks());

describe('merge-gate refresh after restamp', () => {
  it('plans refresh for the newest failed gate before the restamp', () => {
    expect(plan([gate({ id: 9 }), gate(), gate({ id: 11, name: 'tests' })])).toEqual({ checkRunId: 10 });
  });
  it.each([
    { status: 'completed', conclusion: 'success' },
    { status: 'queued', conclusion: null, started_at: null },
    { head_sha: 'b'.repeat(40) },
    { started_at: new Date(restampedAtMs).toISOString() },
    { started_at: new Date(restampedAtMs + 1000).toISOString() },
  ])('does not fall back past newer gate %j', extra => {
    expect(plan([gate(), gate({ id: 11, ...extra })])).toBeNull();
  });
  it.each([null, [], [gate({ started_at: null })], [gate({ id: null })]])(
    'refuses incomplete evidence %j', checks => expect(plan(checks)).toBeNull());
  it.each([
    { total: 101, gateIndex: 0 },
    { total: 101, gateIndex: 100 },
    { total: 250, gateIndex: 249 },
  ])('refreshes with unrelated CI history %j by requesting only merge-gate checks', ({ total, gateIndex }) => {
    const checkRuns = Array.from({ length: total }, (_, i) => gate({ id: i + 1, name: `ci-${i}` }));
    checkRuns[gateIndex] = gate({ id: gateIndex + 1 });
    const base = fixture();
    const gh = vi.fn((file, args, options) => {
      if (args[0] === 'api' && args[1].includes('/check-runs')) {
        const query = new URL(args[1], 'https://api.github.test/').searchParams;
        const selected = query.get('check_name') === 'merge-gate'
          ? checkRuns.filter(check => check.name === 'merge-gate') : checkRuns;
        return JSON.stringify({ total_count: selected.length, check_runs: selected.slice(0, 100) });
      }
      return base(file, args, options);
    });
    expect(run(gh)).toEqual({ ok: true, refreshed: true });
    expect(gh.mock.calls.at(-2)[1]).toContain('--add-label');
    expect(gh.mock.calls.at(-1)[1]).toContain('--remove-label');
    expect(gh).toHaveBeenCalledTimes(6);
  });
  it('creates the neutral label then adds and removes it after checking the live head', () => {
    const gh = fixture();
    expect(run(gh)).toEqual({ ok: true, refreshed: true });
    expect(gh.mock.calls.map(([, args]) => args)).toEqual([
      ['api', `repos/o/r/commits/${head}/check-runs?per_page=100&filter=all&check_name=merge-gate`],
      ['api', 'repos/o/r/pulls/7'],
      ['pr', 'view', '7', '--repo', 'o/r', '--json', 'labels'],
      ['label', 'create', 'gate:refresh', '--repo', 'o/r', '--color', 'ededed', '--description', 'Refresh merge-gate after acceptance restamp'],
      ['pr', 'edit', '7', '--repo', 'o/r', '--add-label', 'gate:refresh'],
      ['pr', 'edit', '7', '--repo', 'o/r', '--remove-label', 'gate:refresh'],
    ]);
  });
  it('bounds all three reads to 2 MiB and a 30-second timeout', () => {
    const gh = fixture();
    expect(run(gh)).toEqual({ ok: true, refreshed: true });
    const reads = gh.mock.calls.filter(([, args]) => args[0] === 'api' || args[1] === 'view');
    expect(reads).toHaveLength(3);
    expect(reads.map(([, args]) => args[1])).toEqual([
      `repos/o/r/commits/${head}/check-runs?per_page=100&filter=all&check_name=merge-gate`,
      'repos/o/r/pulls/7',
      'view',
    ]);
    for (const [, , options] of reads) {
      expect(options).toMatchObject({ maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
    }
  });
  it.each(['check-runs', 'pulls'])('fails closed without label mutations when the %s API read exceeds its byte limit', phase => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const base = fixture();
    const gh = vi.fn((file, args, options) => {
      const response = base(file, args, options);
      if (args[0] === 'api' && args[1].includes(`/${phase}`)) {
        // Exercise Node's real transport limit with a local child, never GitHub.
        // Trailing JSON whitespace keeps the response valid if the bound breaks.
        return execFileSync(process.execPath, ['-e',
          "process.stdout.write(process.argv[1] + ' '.repeat(2 * 1024 * 1024))", response], options);
      }
      return response;
    });
    const result = run(gh);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ENOBUFS') });
    expect(result.error).toContain('retry restamp');
    expect(stderr.mock.calls.flat().join('')).toContain('ENOBUFS');
    expect(gh).toHaveBeenCalledTimes(phase === 'check-runs' ? 1 : 2);
    expect(gh.mock.calls.every(([, args]) => args[0] === 'api')).toBe(true);
  });
  it('continues when the neutral label already exists', () => {
    const base = fixture();
    const gh = vi.fn((file, args, opts) => {
      if (args[0] === 'label') throw new Error('label already exists');
      return base(file, args, opts);
    });
    expect(run(gh)).toEqual({ ok: true, refreshed: true });
    expect(gh.mock.calls.at(-1)[1]).toContain('--remove-label');
  });
  it.each(['create', '--add-label'])('retries %s three times with backoff and reports failure without throwing', phase => {
    const base = fixture();
    const sleep = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const gh = vi.fn((file, args, opts) => {
      if (args.includes(phase)) throw new Error('daemon token denied');
      return base(file, args, opts);
    });
    expect(run(gh, { sleep })).toMatchObject({ ok: false, error: expect.stringContaining('daemon token denied') });
    expect(gh.mock.calls.filter(([, args]) => args.includes(phase))).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    expect(stderr.mock.calls.flat().join('')).toContain('daemon token denied');
  });
  it.each([true, false])('label absent → add ok → remove fails stays successful with a note; final removal succeeds: %s', finalSucceeds => {
    const base = fixture(), sleep = vi.fn();
    let removes = 0;
    const gh = vi.fn((file, args, opts) => {
      if (args.includes('--remove-label') && (++removes < 4 || !finalSucceeds)) throw new Error('cleanup denied');
      return base(file, args, opts);
    });
    const out = run(gh, { sleep });
    expect(out).toMatchObject({ ok: true, refreshed: true, note: expect.stringContaining('merge-gate triggered') });
    expect(out.note).toContain(finalSucceeds ? 'cleanup succeeded' : 'ask an operator to remove gate:refresh');
    expect(gh.mock.calls.filter(([, args]) => args.includes('--add-label'))).toHaveLength(1);
    expect(gh.mock.calls.filter(([, args]) => args[1] === 'view' || args[1] === 'edit').map(([, args]) =>
      args[1] === 'view' ? 'read labels' : args.at(-2))).toEqual([
      'read labels', '--add-label', ...Array(4).fill('--remove-label'),
    ]);
    expect(removes).toBe(4);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });
  it('label already present and pre-remove fails reports failure without adding', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const base = fixture([gate()], head, 1, [{ name: 'gate:refresh' }]);
    const sleep = vi.fn();
    const gh = vi.fn((file, args, opts) => {
      if (args.includes('--remove-label')) throw new Error('pre-remove denied');
      return base(file, args, opts);
    });
    expect(run(gh, { sleep })).toMatchObject({ ok: false, error: expect.stringContaining('pre-remove denied') });
    expect(gh.mock.calls.filter(([, args]) => args.includes('--remove-label'))).toHaveLength(3);
    expect(gh.mock.calls.some(([, args]) => args.includes('--add-label'))).toBe(false);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });
  it('label present and pre-remove ok makes the add trigger a real transition', () => {
    let present = true;
    const base = fixture([gate()], head, 1, [{ name: 'gate:refresh' }]);
    const transitions = [];
    const gh = vi.fn((file, args, opts) => {
      if (args.includes('--remove-label')) { transitions.push('remove'); present = false; }
      if (args.includes('--add-label')) {
        expect(present).toBe(false);
        transitions.push('add');
        present = true;
      }
      return base(file, args, opts);
    });
    expect(run(gh)).toEqual({ ok: true, refreshed: true });
    expect(transitions).toEqual(['remove', 'add', 'remove']);
    expect(present).toBe(false);
  });
  it.each(['unreadable', 'invalid JSON', 'missing labels', 'malformed labels', 'oversized'])(
    'fails closed on %s PR label evidence before any label mutation', kind => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const base = fixture();
      const gh = vi.fn((file, args, opts) => {
        if (args[0] === 'pr' && args[1] === 'view') {
          if (kind === 'unreadable') throw new Error('label read denied');
          if (kind === 'invalid JSON') return '{';
          if (kind === 'missing labels') return '{}';
          if (kind === 'malformed labels') return JSON.stringify({ labels: [{}] });
          return execFileSync(process.execPath, ['-e',
            "process.stdout.write('{\"labels\":[]}' + ' '.repeat(2 * 1024 * 1024))"], opts);
        }
        return base(file, args, opts);
      });
      expect(run(gh)).toMatchObject({ ok: false, error: expect.stringContaining('operator to toggle gate:refresh') });
      expect(gh.mock.calls).toHaveLength(3);
      expect(gh.mock.calls.some(([, args]) => args[0] === 'label' || args[1] === 'edit')).toBe(false);
    });
  it('recovers a transient add failure before removing the label', () => {
    const base = fixture();
    let adds = 0;
    const gh = vi.fn((file, args, opts) => {
      if (args.includes('--add-label') && ++adds === 1) throw new Error('temporary');
      return base(file, args, opts);
    });
    expect(run(gh)).toMatchObject({ ok: true, refreshed: true });
    expect(adds).toBe(2);
    expect(gh.mock.calls.at(-1)[1]).toContain('--remove-label');
  });
  it.each(['present', 'unreadable', 'malformed', 'incomplete', 'oversized'])(
    'treats an add timeout with %s label evidence as triggered and attempts cleanup once', evidence => {
      const base = fixture();
      let added = false;
      const sleep = vi.fn();
      const gh = vi.fn((file, args, opts) => {
        if (args.includes('--add-label')) { added = true; throw new Error('add timed out'); }
        if (added && args[1] === 'view') {
          if (evidence === 'unreadable') throw new Error('offline');
          if (evidence === 'oversized') throw new Error('ENOBUFS');
          if (evidence === 'malformed') return '{';
          return JSON.stringify(evidence === 'incomplete' ? {} : { labels: [{ name: 'gate:refresh' }] });
        }
        if (args.includes('--remove-label')) throw new Error('cleanup denied');
        return base(file, args, opts);
      });
      const result = run(gh, { sleep });
      expect(result).toMatchObject({ ok: true, refreshed: true, note: expect.stringContaining('treated as triggered') });
      expect(result.note).toContain(evidence === 'present' ? 'gate:refresh is present' : 'label read failed');
      expect(result.note).toContain('operator to inspect the gate');
      expect(result.note).toContain('operator to remove gate:refresh');
      expect(gh.mock.calls.filter(([, args]) => args.includes('--add-label'))).toHaveLength(1);
      expect(gh.mock.calls.filter(([, args]) => args[1] === 'view')).toHaveLength(2);
      expect(gh.mock.calls.filter(([, args]) => args.includes('--remove-label'))).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  it('fails after bounded add errors only when each follow-up label read confirms absence', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const base = fixture();
    const gh = vi.fn((file, args, opts) => {
      if (args.includes('--add-label')) throw new Error('add denied');
      return base(file, args, opts);
    });
    expect(run(gh)).toMatchObject({ ok: false, error: expect.stringContaining('add denied') });
    expect(gh.mock.calls.filter(([, args]) => args.includes('--add-label'))).toHaveLength(3);
    expect(gh.mock.calls.filter(([, args]) => args[1] === 'view')).toHaveLength(4);
    expect(gh.mock.calls.some(([, args]) => args.includes('--remove-label'))).toBe(false);
  });
  it('refreshes a still-running gate that began before the restamp (it may have read the old thread)', () => {
    const gh = fixture([gate({ status: 'in_progress', conclusion: null })]);
    expect(run(gh)).toEqual({ ok: true, refreshed: true });
  });
  it.each([0, 100])('accepts complete filtered evidence containing %i gates', count => {
    const gh = fixture(Array.from({ length: count }, (_, i) => gate({ id: i + 1 })));
    expect(run(gh)).toEqual({ ok: true, refreshed: count > 0 });
  });
  it('fails closed with an operator fallback when gate history itself exceeds the page bound', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const gh = fixture(Array.from({ length: 101 }, (_, i) => gate({ id: i + 1 })));
    expect(run(gh)).toMatchObject({ ok: false, error: expect.stringContaining('operator to toggle gate:refresh') });
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it.each(['moved', 'oversized', 'unreadable'])('fails closed on %s evidence and names operator fallback', phase => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const gh = phase === 'unreadable' ? vi.fn(() => { throw new Error('offline'); })
      : fixture([gate()], phase === 'moved' ? 'b'.repeat(40) : head, phase === 'oversized' ? 101 : 1);
    expect(run(gh)).toMatchObject({ ok: false, error: expect.stringContaining('retry restamp') });
    expect(gh.mock.calls.every(([, args]) => args[0] === 'api')).toBe(true);
  });
  it('writes no state file or attempt marker and retries naturally on the next call', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const write = vi.spyOn(fs, 'writeFileSync');
    const base = fixture();
    let failing = true;
    const gh = vi.fn((file, args, opts) => {
      if (failing && args.includes('--add-label')) throw new Error('offline');
      return base(file, args, opts);
    });
    expect(run(gh).ok).toBe(false);
    failing = false;
    expect(run(gh)).toMatchObject({ ok: true, refreshed: true });
    expect(write).not.toHaveBeenCalled();
    const source = fs.readFileSync('scripts/lib/merge-gate-refresh.mjs', 'utf8');
    expect(source).not.toMatch(/node:fs|writeFile|mkdir|run', 'rerun/);
  });
  it('wires only successful restamps after all writes and includes the helper result in JSON', () => {
    const source = fs.readFileSync('scripts/review-set-label.mjs', 'utf8');
    expect(source).toContain("import { refreshMergeGateAfterRestamp } from './lib/merge-gate-refresh.mjs'");
    expect(source).toMatch(/for \(const step of order\) \{ steps\[step\]\(\); \}\s*const refreshFn = refreshGate \?\? \(liveGhProviders\.has\(provider\) \? refreshMergeGateAfterRestamp : null\);\s*const gateRefresh = to === 'restamp' && refreshFn\s*\? refreshFn\(\{ repo, pr, head: headSha, restampedAtMs: restampedAt \}\)/);
    expect(source).toMatch(/\.\.\.successResult\(\{ pr: Number\(pr\), to, decision, labels: newLabels \}\),\s*\.\.\.\(gateRefresh \? \{ gateRefresh \} : \{\}\)/);
  });
  it('the workflow label-event filter lets gate:refresh through (else the toggle never re-runs the gate)', () => {
    const yml = readFileSync(join(process.cwd(), '.github/workflows/merge-gate.yml'), 'utf8');
    const filters = yml.split('\n').filter(l => /^\s*(name|if|group):/.test(l) && l.includes("!= 'ready-to-merge'"));
    expect(filters.length).toBe(3);
    for (const l of filters) expect(l).toContain("github.event.label.name != 'gate:refresh'");
  });
});
