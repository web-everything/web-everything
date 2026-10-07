import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  assessBuilderStarvation, parseTickRows, classifyPrMovement, renderSweepReport,
  SWEEP_JOBS, buildLaunchdPlist, installPlan,
  attentionSignature, decideNotify, runCoronerJob, formatErrorRates, opusCommand, applyInstallPlan,
} from '../scheduled-sweep.mjs';
import { DAEMON_MANIFEST } from '../../../skills-src/conveyor/daemon-manifest.mjs';

const MIN = 60_000;
const now = Date.parse('2026-10-07T12:00:00Z');
const tick = (minAgo, extra = {}) => ({
  at: new Date(now - minAgo * MIN).toISOString(),
  status: 'conveyor · 0 building · 3 preparing · 0 fixing · 0 healing · 12 queued · 0 parked',
  inFlight: [], openItems: { count: 0, cap: 7 }, dispatched: [], prepare: { launched: [] }, ...extra,
});

describe('assessBuilderStarvation', () => {
  it('flags queue>0, free capacity, and no launch for 60 min (the 2026-10-07 overnight case)', () => {
    const rows = [tick(400, { dispatched: [{ num: '1' }] }), tick(120), tick(60), tick(2)];
    const r = assessBuilderStarvation(rows, { now });
    expect(r.starved).toBe(true);
    expect(r.queued).toBe(12);
    expect(r.freeSlots).toBeGreaterThan(0);
    expect(r.minutesSinceLaunch).toBe(400);
  });
  it('a build launch inside the window clears it', () => {
    const rows = [tick(30, { dispatched: [{ num: '1' }] }), tick(2)];
    expect(assessBuilderStarvation(rows, { now }).starved).toBe(false);
  });
  it('a prepare launch counts as a launch', () => {
    const rows = [tick(30, { prepare: { launched: [{ num: '9' }] } }), tick(2)];
    expect(assessBuilderStarvation(rows, { now }).starved).toBe(false);
  });
  it('empty queue or full capacity is not starvation', () => {
    expect(assessBuilderStarvation([tick(2, { status: '0 queued' })], { now }).starved).toBe(false);
    expect(assessBuilderStarvation([tick(2, { inFlight: [{}], openItems: { count: 7, cap: 7 } })], { now, buildCap: 1 }).starved).toBe(false);
  });
  it('honours the threshold knob and reports no-data without alarming', () => {
    expect(assessBuilderStarvation([tick(2)], { now, thresholdMin: 1 }).starved).toBe(true);
    const r = assessBuilderStarvation([], { now });
    expect(r.starved).toBe(false);
    expect(r.noData).toBe(true);
  });
  it('a stale newest tick (daemon down) is reported as stale, not starved', () => {
    const r = assessBuilderStarvation([tick(300)], { now });
    expect(r.daemonStale).toBe(true);
  });
});

describe('parseTickRows', () => {
  it('keeps tick rows and drops noise lines', () => {
    const text = ['2026-10-07T10:54:02Z noise', JSON.stringify(tick(1)), '{"x":1}', 'not json'].join('\n');
    expect(parseTickRows(text)).toHaveLength(1);
  });
});

describe('classifyPrMovement', () => {
  const pr = (o) => ({ number: 1, title: 't', isDraft: false, updatedAt: new Date(now - 5 * MIN).toISOString(), labels: [], mergeable: 'MERGEABLE', statusCheckRollup: [], ...o });
  it('buckets stalled, conflicting, red and send-back PRs', () => {
    const out = classifyPrMovement([
      pr({ number: 1 }),
      pr({ number: 2, updatedAt: new Date(now - 200 * MIN).toISOString() }),
      pr({ number: 3, mergeable: 'CONFLICTING' }),
      pr({ number: 4, statusCheckRollup: [{ conclusion: 'FAILURE', name: 'test' }] }),
      pr({ number: 5, labels: [{ name: 'review:changes' }] }),
    ], { now, stalledMin: 90 });
    expect(out.moving.map((p) => p.number)).toEqual([1]);
    expect(out.stalled.map((p) => p.number)).toContain(2);
    expect(out.conflicting.map((p) => p.number)).toEqual([3]);
    expect(out.red.map((p) => p.number)).toEqual([4]);
    expect(out.changesRequested.map((p) => p.number)).toEqual([5]);
  });
});

describe('report and wiring', () => {
  it('renders attention first', () => {
    const md = renderSweepReport({ job: 'pr-movement', at: '2026-10-07T12:00:00.000Z', attention: ['builder starved'], sections: [{ title: 'PRs', lines: ['a'] }] });
    expect(md.indexOf('builder starved')).toBeLessThan(md.indexOf('PRs'));
  });
  it('declares the three jobs as non-default manifest passes', () => {
    expect(Object.keys(SWEEP_JOBS).sort()).toEqual(['coroner', 'opus', 'pr-movement']);
    for (const [job, name] of [['pr-movement', 'pr-movement-sweep'], ['coroner', 'coroner-sweep'], ['opus', 'opus-sweep']]) {
      const e = DAEMON_MANIFEST[name];
      expect(e, name).toBeDefined();
      expect(e.script).toBe('scripts/operations/scheduled-sweep.mjs');
      expect(e.args).toEqual(['run', job]);
      expect(e.defaultLaunch).toBe(false);
    }
    expect(DAEMON_MANIFEST['pr-movement-sweep'].intervalMs).toBe(30 * MIN);
  });
  it('plist runs the pass daemon for the named pass and install is default-off', () => {
    const xml = buildLaunchdPlist({ pass: 'pr-movement-sweep', repoRoot: '/r', nodePath: '/n', home: '/h' });
    expect(xml).toContain('com.we.conveyor-pass-daemon.pr-movement-sweep');
    expect(xml).toContain('--pass=pr-movement-sweep');
    const plan = installPlan({ repoRoot: '/r', nodePath: '/n', home: '/h', apply: false });
    expect(plan.writes).toEqual([]);
    expect(plan.commands.length).toBe(3);
    expect(plan.commands.join('\n')).toContain('launchctl bootstrap');
  });
  it('install is default-off when apply is OMITTED (the real default), and only --apply plans writes', () => {
    expect(installPlan({ repoRoot: '/r', nodePath: '/n', home: '/h' }).writes).toEqual([]);
    expect(installPlan({ repoRoot: '/r', nodePath: '/n', home: '/h', apply: true }).writes).toHaveLength(3);
  });
});

describe('builder starvation: a busy builder is not starved (review finding, real tick shape)', () => {
  const busy = (extra = {}) => tick(2, { status: 'conveyor · 2 building · 20 preparing · 0 fixing · 0 healing · 409 queued · 0 parked', inFlight: [], openItems: { count: 0, cap: 7 }, ...extra });
  it('building count in the status line occupies the slots even when inFlight is empty', () => {
    const r = assessBuilderStarvation([tick(400, { dispatched: [{ num: '1' }] }), busy()], { now, buildCap: 1 });
    expect(r.starved).toBe(false);
    expect(r.freeSlots).toBe(0);
  });
  it('a frozen build dispatch (kill switch / landing freeze) is not starvation', () => {
    const idle = tick(2, { status: 'conveyor · 0 building · 409 queued', freeze: { frozen: true } });
    expect(assessBuilderStarvation([tick(400, { dispatched: [{ num: '1' }] }), idle], { now }).starved).toBe(false);
  });
  it('still starved when nothing is building and capacity is free', () => {
    const idle = tick(2, { status: 'conveyor · 0 building · 20 preparing · 409 queued', inFlight: [] });
    expect(assessBuilderStarvation([tick(400, { dispatched: [{ num: '1' }] }), idle], { now, buildCap: 1 }).starved).toBe(true);
  });
  it('a larger cap leaves room: 2 building under cap 4 is 2 free slots', () => {
    const r = assessBuilderStarvation([tick(400, { dispatched: [{ num: '1' }] }), busy()], { now, buildCap: 4 });
    expect(r.freeSlots).toBe(2);
  });
});

describe('notification de-dup (review finding: minutes-since-launch changed the signature every run)', () => {
  const a = (min, queued) => [`BUILDER STARVED: ${queued} queued, 1 free slot(s), last build/prepare launch ${min} min ago (threshold 60 min)`];
  it('two runs differing only in minutes / queue depth share a signature', () => {
    expect(attentionSignature(a(116, 401))).toBe(attentionSignature(a(146, 380)));
  });
  it('a genuinely different attention list changes the signature', () => {
    expect(attentionSignature(a(116, 401))).not.toBe(attentionSignature([...a(116, 401), '2 PR(s) stalled']));
    expect(attentionSignature(['2 PR(s) stalled'])).not.toBe(attentionSignature(['2 PR(s) conflicting']));
  });
  it('drifting counts (PRs ageing in, free slots, gh error text) keep the same signature', () => {
    expect(attentionSignature(['2 PR(s) stalled'])).toBe(attentionSignature(['3 PR(s) stalled']));
    expect(attentionSignature(['BUILDER STARVED: 9 queued, 2 free slot(s), last build/prepare launch 90 min ago (threshold 60 min)']))
      .toBe(attentionSignature(['BUILDER STARVED: 8 queued, 3 free slot(s), last build/prepare launch 95 min ago (threshold 60 min)']));
    expect(attentionSignature(['gh pr list failed: HTTP 502 after 31s'])).toBe(attentionSignature(['gh pr list failed: HTTP 502 after 33s']));
  });
  it('notifies on first sight and on change, not on a repeat', () => {
    const sig = attentionSignature(a(116, 401));
    expect(decideNotify({ attention: a(116, 401), prevSig: '' }).notify).toBe(true);
    expect(decideNotify({ attention: a(146, 380), prevSig: sig }).notify).toBe(false);
  });
  it('an empty attention list never notifies and records the empty signature (so a recurrence notifies again)', () => {
    const d = decideNotify({ attention: [], prevSig: attentionSignature(a(1, 1)) });
    expect(d.notify).toBe(false);
    expect(d.sig).toBe(attentionSignature([]));
    expect(decideNotify({ attention: a(1, 1), prevSig: d.sig }).notify).toBe(true);
  });
});

describe('coroner job (review finding: --since=last throws on a fresh machine)', () => {
  const okOut = JSON.stringify({ errorRates: { gateRuns: { count: 2, total: 10, pct: 20 } } });
  it('falls back to a bounded --since when there is no previous run, and succeeds', () => {
    const calls = [];
    const spawn = (_cmd, args) => {
      calls.push(args);
      return args.includes('--since=last') ? { status: 1, stdout: '', stderr: 'no previous run; pass an ISO --since\n' } : { status: 0, stdout: okOut, stderr: '' };
    };
    const r = runCoronerJob({ env: {}, dryRun: false, now, spawn });
    expect(r.attention).toEqual([]);
    expect(calls).toHaveLength(2);
    const since = calls[1].find((x) => x.startsWith('--since='));
    expect(Date.parse(since.slice('--since='.length))).toBe(now - 24 * 60 * MIN);
  });
  it('also falls back when the state file holds a lastEnd the extractor rejects (never a permanent failure)', () => {
    const spawn = (_c, args) => args.includes('--since=last') ? { status: 1, stderr: 'pass valid ISO --since and --until with since <= until' } : { status: 0, stdout: okOut };
    expect(runCoronerJob({ env: {}, dryRun: false, now, spawn }).attention).toEqual([]);
  });
  it('does not retry on an unrelated failure and reports it', () => {
    let n = 0;
    const r = runCoronerJob({ env: {}, dryRun: false, now, spawn: () => { n++; return { status: 1, stdout: '', stderr: 'boom\n' }; } });
    expect(n).toBe(1);
    expect(r.attention[0]).toMatch(/coroner extract failed \(exit 1\): boom/);
  });
  it('dry run keeps --no-save on both attempts', () => {
    const calls = [];
    runCoronerJob({ env: {}, dryRun: true, now, spawn: (_c, args) => { calls.push(args); return args.includes('--since=last') ? { status: 1, stderr: 'no previous run; pass an ISO --since' } : { status: 0, stdout: okOut }; } });
    expect(calls.every((a) => a.includes('--no-save'))).toBe(true);
  });
  it('formats error rates, never printing undefined for entries without count/total', () => {
    const lines = formatErrorRates({
      gateRuns: { count: 2, total: 10, pct: 20 },
      ci: { workflows: 3 },
      byKind: { code: { prsOpened: 4, ci: { count: 1, total: 5, pct: 20 } }, 'card-only': { prsOpened: 1 } },
    });
    expect(lines.join('\n')).not.toMatch(/undefined/);
    expect(lines).toContain('gateRuns: 2/10 (20%)');
    expect(lines).toContain('byKind.code.ci: 1/5 (20%)');
  });
});

describe('opus sweep is restricted to read-only tools (security finding)', () => {
  it('restricts the BUILT-IN tool set, not just pre-approves three tools', () => {
    const { args } = opusCommand();
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args).toContain('--restricted');
  });
  it('explicitly disallows every mutating or networked tool and never bypasses permissions', () => {
    const { args } = opusCommand();
    const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
    for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) expect(denied).toContain(t);
    expect(args.join(' ')).not.toMatch(/bypass|dangerously/i);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args).toContain('--strict-mcp-config');
  });
  it('is bounded: no persisted session transcript and a spend ceiling', () => {
    const { args } = opusCommand();
    expect(args).toContain('--no-session-persistence');
    expect(Number(args[args.indexOf('--max-budget-usd') + 1])).toBeGreaterThan(0);
  });
});

describe('PR red classification covers CheckRun conclusions AND legacy StatusContext states', () => {
  const pr = (rollup) => ({ number: 1, title: 't', isDraft: false, updatedAt: new Date(now - 5 * MIN).toISOString(), labels: [], mergeable: 'MERGEABLE', statusCheckRollup: rollup });
  const cases = [
    [{ conclusion: 'FAILURE' }, true], [{ conclusion: 'TIMED_OUT' }, true], [{ conclusion: 'STARTUP_FAILURE' }, true],
    [{ state: 'FAILURE' }, true], [{ state: 'ERROR' }, true],
    [{ conclusion: 'SUCCESS' }, false], [{ conclusion: 'SKIPPED' }, false], [{ conclusion: '' , status: 'IN_PROGRESS' }, false],
    [{ state: 'SUCCESS' }, false], [{ state: 'PENDING' }, false], [{}, false],
  ];
  it.each(cases)('%j red=%s', (check, red) => {
    const out = classifyPrMovement([pr([check])], { now });
    expect(out.red).toHaveLength(red ? 1 : 0);
    expect(out.moving).toHaveLength(red ? 0 : 1);
  });
});

describe('installer guarantees are enforced by tested code, not top-level script text', () => {
  const plan = installPlan({ repoRoot: '/r', nodePath: '/n', home: '/h', apply: true });
  const fakeFs = (existing = []) => {
    const log = { mkdir: [], write: [] };
    // `existsSync` is deliberately BLIND (like a dangling symlink): only an exclusive-create flag can protect the path.
    return {
      log, existsSync: () => false, mkdirSync: (p) => log.mkdir.push(p),
      writeFileSync: (p, x, o) => {
        if (existing.includes(p) && o?.flag === 'wx') throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        if (existing.includes(p)) log.clobbered = (log.clobbered ?? []).concat(p);
        log.write.push([p, x]);
      },
    };
  };
  it('never overwrites an existing plist, writes the rest', () => {
    const fs = fakeFs([plan.writes[0].path]);
    const r = applyInstallPlan({ plan, fs, home: '/h' });
    expect(r.skipped).toEqual([plan.writes[0].path]);
    expect(fs.log.write.map(([p]) => p)).toEqual(plan.writes.slice(1).map((f) => f.path));
    expect(fs.log.clobbered).toBeUndefined();
  });
  it('writes nothing for the default (no --apply) plan', () => {
    const fs = fakeFs();
    const r = applyInstallPlan({ plan: installPlan({ repoRoot: '/r', nodePath: '/n', home: '/h' }), fs, home: '/h' });
    expect(fs.log.write).toEqual([]);
    expect(r.wrote).toEqual([]);
  });
  it('the installer script never imports child_process or executes launchctl', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'install-scheduled-sweeps.mjs'), 'utf8');
    expect(src).not.toMatch(/child_process|spawn|exec(File)?Sync|execa/);
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/launchctl/);
  });
});
