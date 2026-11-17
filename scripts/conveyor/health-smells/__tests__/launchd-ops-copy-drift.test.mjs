/**
 * @file scripts/conveyor/health-smells/__tests__/launchd-ops-copy-drift.test.mjs
 * @description Fixture-driven (no real launchd, no real git): a launchd job running an out-of-repo copy of a
 * repo script that differs from origin/main is a finding; matching, counterpart-less and unreadable cases are not.
 */
import { describe, it, expect, vi } from 'vitest';
import smell, { realDeps, scanLaunchdOpsCopyDrift } from '../launchd-ops-copy-drift.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
import { emptyHealthState, episodeKey, runHealthTick } from '../../health-watch-core.mjs';

const HOME = '/home/fixture';
const COPY = `${HOME}/ops/handoff/sync-guard-clone.mjs`;
const REPO_PATH = 'scripts/sync-guard-clone.mjs';
const DAY = 86_400_000;

function deps(over = {}) {
  const plists = over.plists ?? { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: ['/usr/bin/node', COPY] } };
  return {
    home: HOME,
    listPlists: () => Object.keys(plists).concat(over.extraNames ?? []),
    readPlist: (name) => { if (!plists[name]) throw new Error('unreadable'); return plists[name]; },
    inGitCheckout: () => false,
    repoFilesByBasename: (b) => (b === 'sync-guard-clone.mjs' ? [REPO_PATH] : []),
    hashCopy: () => 'aaa',
    hashMain: () => 'aaa',
    copyMtimeMs: () => 10 * DAY,
    mainCommitMs: () => 13 * DAY,
    ...over.fn,
  };
}

describe('scanLaunchdOpsCopyDrift', () => {
  it('matching copy -> no finding', () => {
    expect(scanLaunchdOpsCopyDrift(deps())).toEqual([]);
  });

  it('drifted copy -> finding with label, copy path, repo path and staleness', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ fn: { hashCopy: () => 'old' } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: 'medium', label: 'com.we.guard', copyPath: '~/ops/handoff/sync-guard-clone.mjs',
      repoPath: REPO_PATH, staleDays: 3,
    });
    expect(JSON.stringify(out)).not.toContain(HOME);
  });

  it('no repo counterpart -> no finding', () => {
    expect(scanLaunchdOpsCopyDrift(deps({ fn: { repoFilesByBasename: () => [] } }))).toEqual([]);
  });

  it('script inside a git checkout -> ignored', () => {
    expect(scanLaunchdOpsCopyDrift(deps({ fn: { hashCopy: () => 'old', inGitCheckout: () => true } }))).toEqual([]);
  });

  it('non com.we./com.plateau. jobs are ignored', () => {
    const plists = { 'com.other.x.plist': { Label: 'com.other.x', ProgramArguments: ['node', COPY] } };
    expect(scanLaunchdOpsCopyDrift(deps({ plists, fn: { hashCopy: () => 'old' } }))).toEqual([]);
  });

  it('unreadable plist -> low-severity note, others still scanned', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ extraNames: ['com.plateau.bad.plist'], fn: { hashCopy: () => 'old' } }));
    expect(out.map((f) => f.severity).sort()).toEqual(['low', 'medium']);
    expect(out.find((f) => f.severity === 'low')).toMatchObject({ label: 'com.plateau.bad' });
  });

  it('missing origin/main file or unreadable copy -> low note, never a false drift', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ fn: { hashMain: () => { throw new Error('no ref'); } } }));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('low');
  });
});

describe('fail closed', () => {
  it.each([false, true])('partial failures allow verified recovery while retaining unknown jobs (reverse order: %s)', (reverse) => {
    let d = deps({ plists: {
      'renamed.plist': { Label: 'com.we.guard', Program: COPY },
      'unknown.plist': { Label: 'com.we.unknown', Program: COPY },
    }, fn: { hashCopy: () => 'old' } });
    const descriptor = { ...smell, evaluate: (p, ctx) => smell.evaluate(p, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(d) }) };
    let state = emptyHealthState();
    let now = 0;
    const tick = () => {
      const result = runHealthTick(state, {}, [descriptor], ++now * 1000);
      state = result.state;
      return result;
    };
    tick(); tick();
    state = JSON.parse(JSON.stringify(state));
    d = deps({ plists: { 'renamed.plist': { Label: 'com.we.guard', Program: COPY } }, extraNames: ['unknown.plist'] });
    if (reverse) d.listPlists = () => ['unknown.plist', 'renamed.plist'];
    tick(); tick();
    expect(state.episodes[episodeKey(smell.id, 'com.we.guard')]).toBeUndefined();
    expect(state.episodes[episodeKey(smell.id, 'com.we.unknown')]).toMatchObject({ status: 'open', cleanStreak: 0 });
  });

  it.each([
    ['/bin/sh', '-c', `node ${COPY}`],
    ['/bin/bash', '-lc', `node '${COPY}'`],
    ['/bin/zsh', '-c', `node "${COPY}"; echo done`],
    ['/usr/bin/env', 'sh', '-c', 'node "$SCRIPT"'],
    ['/bin/sh', '-ec', 'node /home/fixture/ops/"sync-guard"-clone.mjs'],
    ['/bin/sh', '-c', 'node `printf path`\nnode $(printf path)\r\u2028'],
    ['/usr/local/bin/fish', '--command', `node ${COPY}`],
    ['/usr/local/bin/fish', `--command=node ${COPY}`],
  ])('shell command stays unverified through persisted health ticks: %s %s', (...argv) => {
    let d = deps({ fn: { hashCopy: () => 'old' } });
    const descriptor = { ...smell, evaluate: (p, ctx) => smell.evaluate(p, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(d) }) };
    let state = emptyHealthState();
    let now = 0;
    const tick = () => {
      const result = runHealthTick(state, {}, [descriptor], ++now * 1000);
      state = result.state;
      return result;
    };
    tick(); tick();
    state = JSON.parse(JSON.stringify(state));
    d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: argv } } });
    for (let i = 0; i < 3; i++) {
      expect(tick().transitions.some((t) => t.type === 'closed')).toBe(false);
      expect(state.episodes[episodeKey(smell.id, 'com.we.guard')]).toMatchObject({ status: 'open', cleanStreak: 0 });
    }
    const findings = scanLaunchdOpsCopyDrift(d);
    expect(findings).toMatchObject([{ label: 'com.we.guard', severity: 'low', note: expect.stringContaining('shell command') }]);
    expect(JSON.stringify(findings)).not.toContain(HOME);
    d = deps();
    tick(); tick();
    expect(state.episodes[episodeKey(smell.id, 'com.we.guard')]).toBeUndefined();
  });

  it.each([
    ['/usr/bin/env', '-S', `sh -c "node ${COPY}"`],
    ['/usr/bin/env', '-S', `bash -lc 'node ${COPY}'`],
    ['/usr/bin/env', `-Ssh -c "node ${COPY}"`],
    ['/usr/bin/env', `--split-string=zsh -c "node ${COPY}"`],
    ['/usr/bin/env', '--split-string', `/bin/sh -c "node ${COPY}"`],
    ['/usr/bin/env', '-i', 'FOO=1', '-S', `sh -c "node ${COPY}"`],
    ['/usr/bin/env', '-S', `sh -c "node ${COPY}`],
    ['/usr/bin/env', '-S', `sh -c 'node ${COPY}`],
  ])('env -S split strings are inspected for a shell, never read as clean: %j', (...argv) => {
    const d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: argv } } });
    expect(scanLaunchdOpsCopyDrift(d)).toMatchObject([{ label: 'com.we.guard', severity: 'low', note: expect.stringContaining('cannot be verified') }]);
  });

  it.each([
    ['/usr/bin/caffeinate', '-i', 'sh', '-c', `node ${COPY}`],
    ['/usr/bin/nohup', 'bash', '-lc', `node ${COPY}`],
    ['/usr/bin/arch', '-arm64', '/bin/zsh', '-c', `node ${COPY}`],
    ['/usr/bin/env', '--', 'sh', '-c', `node ${COPY}`],
  ])('wrapper launchers in front of a shell command stay unverified: %j', (...argv) => {
    const d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: argv } } });
    expect(scanLaunchdOpsCopyDrift(d)).toMatchObject([{ label: 'com.we.guard', severity: 'low', note: expect.stringContaining('cannot be verified') }]);
  });

  it('env -S that runs a plain script stays verifiable and flags drift', () => {
    const d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: ['/usr/bin/env', '-S', `node ${COPY}`] } }, fn: { hashCopy: () => 'old' } });
    expect(scanLaunchdOpsCopyDrift(d)).toMatchObject([{ label: 'com.we.guard', severity: 'medium', staleDays: 3 }]);
    expect(scanLaunchdOpsCopyDrift(deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: ['/usr/bin/env', '-S', `node ${COPY}`] } } }))).toEqual([]);
  });

  it('env -S shell command keeps an open episode open through production health ticks', () => {
    let d = deps({ fn: { hashCopy: () => 'old' } });
    const descriptor = { ...smell, evaluate: (p, ctx) => smell.evaluate(p, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(d) }) };
    let state = emptyHealthState();
    let now = 0;
    const tick = () => { const r = runHealthTick(state, {}, [descriptor], ++now * 1000); state = r.state; return r; };
    tick(); tick();
    d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: ['/usr/bin/env', '-S', `sh -c "node ${COPY}"`] } } });
    for (let i = 0; i < 3; i++) {
      expect(tick().transitions.some((t) => t.type === 'closed')).toBe(false);
      expect(state.episodes[episodeKey(smell.id, 'com.we.guard')]).toMatchObject({ status: 'open', cleanStreak: 0 });
    }
  });

  it.each([
    ['/usr/bin/env', '-S', String.raw`sh\_-c\_'node "$SCRIPT"'`],
    ['/usr/bin/env', '-S', '${SHELL} -c \'node "$SCRIPT"\''],
    ['/usr/bin/env', '-S', '-S "sh -c \'node $SCRIPT\'"'],
    ['/usr/bin/env', '-S', '-S "sh -c true"'],
    ['/usr/bin/env', '-S', 'sh\u00a0-c true'],
    ['/usr/bin/env', '-S', '# cannot determine command'],
    ['/usr/bin/nohup', '/usr/bin/env', '-S', 'sh -c \'node "$SCRIPT"\''],
    ['/usr/bin/env', '-S', ''],
    ['/usr/bin/env', '-S', '""'],
    ['/usr/bin/env', '-S'],
  ])('uncertain env split commands retain persisted episodes: %j', (...argv) => {
    let d = deps({ fn: { hashCopy: () => 'old' } });
    const descriptor = { ...smell, evaluate: (p, ctx) => smell.evaluate(p, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(d) }) };
    let state = emptyHealthState();
    let now = 0;
    const tick = () => { const r = runHealthTick(state, {}, [descriptor], ++now * 1000); state = r.state; return r; };
    tick(); tick();
    state = JSON.parse(JSON.stringify(state));
    d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: argv } } });
    expect(scanLaunchdOpsCopyDrift(d)).toMatchObject([{ label: 'com.we.guard', severity: 'low' }]);
    for (let i = 0; i < 3; i++) {
      expect(tick().transitions.some((t) => t.type === 'closed')).toBe(false);
      expect(state.episodes[episodeKey(smell.id, 'com.we.guard')]).toMatchObject({ status: 'open', cleanStreak: 0 });
    }
    d = deps();
    tick(); tick();
    expect(state.episodes[episodeKey(smell.id, 'com.we.guard')]).toBeUndefined();
  });

  describe('unclassifiable script jobs hold open episodes open, never open new ones', () => {
    const argvs = [
      ['/usr/bin/node', '-e', `require("${COPY}")`],
      ['/usr/bin/node', `--import=${COPY}`],
      ['node', 'ops/sync-guard-clone.mjs'], // relative, no WorkingDirectory
      ['/usr/bin/node', `--import=${HOME}/ops/guard.mjs`, COPY],
      ['/usr/bin/node', COPY, `--import=${HOME}/ops/guard.mjs`],
      ['/usr/bin/node', '-e', `require('${HOME}/ops/guard.cjs')`, COPY],
      ['/usr/bin/node', 'ops/guard.mjs', COPY],
      ['/usr/bin/env', '-S', `node --import=${HOME}/ops/guard.mjs "${COPY}"`],
    ];
    const harness = () => {
      let d = deps({ fn: { hashCopy: () => 'old' } });
      const descriptor = { ...smell, evaluate: (p, ctx) => smell.evaluate(p, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(d) }) };
      let state = emptyHealthState();
      let now = 0;
      const tick = () => { const r = runHealthTick(state, {}, [descriptor], ++now * 1000); state = r.state; return r; };
      return { tick, set: (next) => { d = next; }, ep: () => state.episodes[episodeKey(smell.id, 'com.we.guard')] };
    };
    const job = (ProgramArguments, extra = {}) => deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments, ...extra } } });

    it.each(argvs)('open episode stays open through production ticks: %j', (...argv) => {
      const h = harness();
      h.tick(); h.tick();
      h.set(job(argv));
      for (let i = 0; i < 3; i++) {
        expect(h.tick().transitions.some((t) => t.type === 'closed')).toBe(false);
        expect(h.ep()).toMatchObject({ status: 'open', cleanStreak: 0 });
      }
      expect(scanLaunchdOpsCopyDrift(job(argv))).toMatchObject([{ label: 'com.we.guard', severity: 'low', unclassified: true }]);
    });

    it.each(argvs)('with no open episode nothing is opened: %j', (...argv) => {
      const h = harness();
      h.set(job(argv));
      for (let i = 0; i < 4; i++) h.tick();
      expect(h.ep()).toBeUndefined();
    });

    it('repointing the job into a git checkout or a resolvable script lets the episode recover', () => {
      for (const next of [deps({ fn: { inGitCheckout: () => true } }), deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: ['node', 'ops/sync-guard-clone.mjs'], WorkingDirectory: '/home/fixture' } } })]) {
        const h = harness();
        h.tick(); h.tick();
        h.set(job(argvs[0]));
        h.tick();
        h.set(next);
        h.tick(); h.tick();
        expect(h.ep()).toBeUndefined();
      }
    });

    it('WorkingDirectory does not turn an embedded script option into a verified path', () => {
      const h = harness();
      h.tick(); h.tick();
      h.set(job(['node', `--import=${HOME}/ops/guard.mjs`, COPY], { WorkingDirectory: HOME }));
      for (let i = 0; i < 3; i++) {
        expect(h.tick().transitions.some((t) => t.type === 'closed')).toBe(false);
        expect(h.ep()).toMatchObject({ status: 'open', cleanStreak: 0 });
      }
    });

    it('plain binaries and non-script commands are not unclassified', () => {
      expect(scanLaunchdOpsCopyDrift(job(['/usr/bin/ssh', '-N', 'host']))).toEqual([]);
      expect(scanLaunchdOpsCopyDrift(job(['/usr/bin/python3', '/home/fixture/ops/x.py']))).toEqual([]);
    });
  });

  it('Program + ProgramArguments naming the same drifted script count once per tick', () => {
    const d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', Program: COPY, ProgramArguments: [COPY] } }, fn: { hashCopy: () => 'old' } });
    expect(scanLaunchdOpsCopyDrift(d)).toHaveLength(1);
    expect(smell.evaluate({}, { scan: () => [...scanLaunchdOpsCopyDrift(d), ...scanLaunchdOpsCopyDrift(d)] })).toHaveLength(1);
    const descriptor = { ...smell, evaluate: (p, ctx) => smell.evaluate(p, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(d) }) };
    const key = episodeKey(smell.id, 'com.we.guard');
    const first = runHealthTick(emptyHealthState(), {}, [descriptor], 1000);
    expect(first.state.episodes[key]).toMatchObject({ status: 'pending' });
    expect(runHealthTick(first.state, {}, [descriptor], 2000).state.episodes[key]).toMatchObject({ status: 'open' });
  });

  it('two drifted scripts in one job evaluate as one observation for the label', () => {
    const other = `${HOME}/ops/handoff/other.mjs`;
    const d = deps({ plists: { 'com.we.guard.plist': { Label: 'com.we.guard', ProgramArguments: ['/usr/bin/node', COPY, other] } },
      fn: { hashCopy: () => 'old', repoFilesByBasename: (b) => (b === 'sync-guard-clone.mjs' ? [REPO_PATH] : b === 'other.mjs' ? ['scripts/other.mjs'] : []) } });
    expect(scanLaunchdOpsCopyDrift(d)).toHaveLength(2);
    expect(smell.evaluate({}, { scan: () => scanLaunchdOpsCopyDrift(d) })).toHaveLength(1);
  });

  it('Program shell with custom argv zero is unverified, even beside a matching direct script', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ plists: {
      'com.we.guard.plist': { Label: 'com.we.guard', Program: '/bin/sh', ProgramArguments: ['custom-name', '-c', `node ${COPY}`, COPY] },
    } }));
    expect(out).toMatchObject([{ label: 'com.we.guard', severity: 'low' }]);
  });

  it.each([false, true])('a finding overrides a clean duplicate Label during partial scans (reverse order: %s)', (reverse) => {
    const plists = {
      'direct.plist': { Label: 'com.we.guard', Program: COPY },
      'shell.plist': { Label: 'com.we.guard', ProgramArguments: ['/bin/sh', '-c', `node ${COPY}`] },
    };
    const d = deps({ plists, extraNames: ['unreadable.plist'] });
    if (reverse) d.listPlists = () => ['unreadable.plist', 'shell.plist', 'direct.plist'];
    // Evidence survives the scanner's public JSON representation as well.
    const findings = JSON.parse(JSON.stringify(scanLaunchdOpsCopyDrift(d)));
    expect(findings.find((f) => f.coverageIncomplete).verifiedCleanLabels).not.toContain('com.we.guard');
    expect(smell.evaluate({}, { scan: () => findings })).toContainEqual(expect.objectContaining({
      subject: 'com.we.guard', breach: true, measure: expect.objectContaining({ unverified: true }),
    }));
  });

  it('shell-like data arguments to a non-shell executable do not prevent verified recovery', () => {
    const plists = { 'com.we.guard.plist': {
      Label: 'com.we.guard', Program: '/usr/bin/node', ProgramArguments: ['sh', COPY, '-c', 'data'],
    } };
    expect(scanLaunchdOpsCopyDrift(deps({ plists }))).toEqual([]);
  });

  it('failed real counterpart discovery reads the tree only once per scan', () => {
    const git = vi.fn(() => { throw new Error('missing origin/main'); });
    const d = realDeps({ home: HOME, repoRoot: '/fixture/repo', exec: git });
    expect(() => d.repoFilesByBasename('a.mjs')).toThrow('missing origin/main');
    expect(() => d.repoFilesByBasename('b.mjs')).toThrow('missing origin/main');
    expect(git).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'scripts'], {
      cwd: '/fixture/repo', encoding: 'buffer', timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    });
  });

  it('a new scan recovers after failed discovery and caches the successful tree', () => {
    const exec = vi.fn()
      .mockImplementationOnce(() => { throw new Error('missing origin/main'); })
      .mockReturnValue(Buffer.from(`${REPO_PATH}\nscripts/other.mjs\n`));
    const failed = realDeps({ home: HOME, repoRoot: '/fixture/repo', exec });
    expect(() => failed.repoFilesByBasename('a.mjs')).toThrow('missing origin/main');
    const recovered = realDeps({ home: HOME, repoRoot: '/fixture/repo', exec });
    expect(recovered.repoFilesByBasename('sync-guard-clone.mjs')).toEqual([REPO_PATH]);
    expect(recovered.repoFilesByBasename('other.mjs')).toEqual(['scripts/other.mjs']);
    expect(recovered.repoFilesByBasename('absent.mjs')).toEqual([]);
    expect(() => failed.repoFilesByBasename('b.mjs')).toThrow('missing origin/main');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('incomplete scans carry each existing subject once and exclude other smells', () => {
    // No readable guard plist: this case tests carry-forward of an unknown identity.
    const scan = () => scanLaunchdOpsCopyDrift(deps({ plists: {}, extraNames: ['renamed.plist', 'another.plist'] }));
    const key = episodeKey(smell.id, 'com.we.guard');
    const results = smell.evaluate({}, { scan, episodes: {
      [key]: { smell: smell.id, subject: 'com.we.guard', status: 'pending' },
      other: { smell: 'another-smell', subject: 'unrelated', status: 'open' },
    } });
    expect(results.map((r) => r.subject).sort()).toEqual(['com.we.guard', 'launchd-agents']);
    expect(results.every((r) => r.breach && r.measure.unverified)).toBe(true);
  });

  it('counterpart discovery failure is a low note and later jobs still scan', () => {
    let calls = 0;
    const d = deps({
      plists: {
        'com.we.first.plist': { Label: 'com.we.first', ProgramArguments: ['node', COPY] },
        'com.we.second.plist': { Label: 'com.we.second', Program: COPY },
      },
      fn: {
        repoFilesByBasename: () => { if (++calls === 1) throw new Error('missing origin/main'); return [REPO_PATH]; },
        hashCopy: () => 'old',
      },
    });
    const findings = scanLaunchdOpsCopyDrift(d);
    expect(calls).toBe(2);
    expect(findings).toMatchObject([
      { severity: 'low', label: 'com.we.first', note: expect.stringContaining('drift not checked') },
      { severity: 'medium', label: 'com.we.second' },
    ]);
    expect(smell.evaluate({}, { scan: () => findings }).map((r) => r.breach)).toEqual([true, true]);
  });

  it.each([
    ['directory', 'matching'], ['directory', 'removed'], ['plist', 'matching'],
  ])('%s failures preserve persisted drift episodes until verified %s recovery', (failure, recovery) => {
    let d = deps({ plists: {
      'renamed.plist': { Label: 'com.we.guard', Program: COPY },
      'com.plateau.second.plist': { Label: 'com.plateau.second', Program: COPY },
    }, fn: { hashCopy: () => 'old' } });
    const descriptor = { ...smell, evaluate: (probes, ctx) => smell.evaluate(probes, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(d) }) };
    let state = emptyHealthState();
    let now = 0;
    const tick = () => {
      const result = runHealthTick(state, {}, [descriptor], ++now * 1000);
      state = result.state;
      return result;
    };
    tick(); tick();
    const keys = ['com.we.guard', 'com.plateau.second'].map((s) => episodeKey(smell.id, s));
    for (const key of keys) expect(state.episodes[key].status).toBe('open');
    // A restart must retain identities using persisted engine state, not scan-local memory.
    state = JSON.parse(JSON.stringify(state));
    d = failure === 'directory'
      ? deps({ fn: { listPlists: () => { throw new Error('EACCES'); } } })
      : { ...d, readPlist: () => { throw new Error('EACCES'); } };
    for (let i = 0; i < 3; i++) {
      expect(tick().transitions.some((t) => t.type === 'closed')).toBe(false);
      for (const key of keys) expect(state.episodes[key]).toMatchObject({ status: 'open', cleanStreak: 0 });
    }
    d = recovery === 'removed' ? deps({ plists: {} }) : deps({ plists: {
      'renamed.plist': { Label: 'com.we.guard', Program: COPY },
      'com.plateau.second.plist': { Label: 'com.plateau.second', Program: COPY },
    } });
    tick();
    for (const key of keys) expect(state.episodes[key].cleanStreak).toBe(1);
    tick();
    for (const key of keys) expect(state.episodes[key]).toBeUndefined();
  });

  it('unreadable LaunchAgents dir -> low note, not an empty clean result', () => {
    const out = scanLaunchdOpsCopyDrift(deps({ fn: { listPlists: () => { throw new Error('EACCES'); } } }));
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('low');
  });

  it('job scope follows the plist Label, not the filename', () => {
    const plists = { 'renamed.plist': { Label: 'com.we.guard', ProgramArguments: ['node', COPY] } };
    const out = scanLaunchdOpsCopyDrift(deps({ plists, fn: { hashCopy: () => 'old' } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'medium', label: 'com.we.guard' });
  });

  it('an archived duplicate cannot mask drift; multiple live counterparts -> low ambiguity note', () => {
    const archived = scanLaunchdOpsCopyDrift(deps({ fn: {
      hashCopy: () => 'old', repoFilesByBasename: () => [REPO_PATH, 'scripts/archive/sync-guard-clone.mjs'],
      hashMain: (p) => (p.includes('archive') ? 'old' : 'aaa'),
    } }));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ severity: 'medium', repoPath: REPO_PATH });
    const ambiguous = scanLaunchdOpsCopyDrift(deps({ fn: { repoFilesByBasename: () => [REPO_PATH, 'scripts/other/sync-guard-clone.mjs'] } }));
    expect(ambiguous.map((f) => f.severity)).toEqual(['low']);
  });

  it('Program field and WorkingDirectory-relative scripts are compared too', () => {
    const plists = {
      'com.we.a.plist': { Label: 'com.we.a', Program: COPY },
      'com.we.b.plist': { Label: 'com.we.b', WorkingDirectory: `${HOME}/ops/handoff`, ProgramArguments: ['/bin/sh', 'sync-guard-clone.mjs'] },
    };
    const out = scanLaunchdOpsCopyDrift(deps({ plists, fn: { hashCopy: () => 'old' } }));
    expect(out.map((f) => f.label).sort()).toEqual(['com.we.a', 'com.we.b']);
  });

  it('unverifiable findings still evaluate as breaches (unknown never reads clean)', () => {
    const r = smell.evaluate({}, { scan: () => [{ severity: 'low', label: 'com.we.x', note: 'plist unreadable' }] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ subject: 'com.we.x', breach: true });
  });
});

describe('smell shape', () => {
  it('is a valid smell and maps findings to breaches', () => {
    expect(() => validateSmellShape(smell, 'launchd-ops-copy-drift.mjs')).not.toThrow();
    const r = smell.evaluate({}, { scan: () => [{ severity: 'medium', label: 'com.we.g', copyPath: '~/a.mjs', repoPath: 'scripts/a.mjs', staleDays: 2 }] });
    expect(r[0]).toMatchObject({ subject: 'com.we.g', breach: true });
  });
});
