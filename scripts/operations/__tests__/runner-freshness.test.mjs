import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { checkMainStaleness, gitRun } from '../../lib/main-staleness.mjs';
import { assertRunnerFreshness, requiresFreshRunner, FRESHNESS_TTL } from '../runner-freshness.mjs';
import { OPERATIONS, resolveOperation, cliPreflight, createCodexAuditSink, finishCodexAudit } from '../run.mjs';
import { isReadOnlyOperation } from '../registry.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import * as auditIo from '../codex-audit-io.mjs';

function recordingGit(ctx, trace = null) {
  const bin = join(ctx.tmp, 'git-bin'), record = join(ctx.tmp, 'git-calls.jsonl');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), '#!/usr/bin/env node\n' +
    "const fs = require('node:fs'), cp = require('node:child_process'), args = process.argv.slice(2);\n" +
    "const keys = Object.entries(process.env).filter(([key]) => /^GIT_CONFIG_KEY_/.test(key)).map(([, value]) => value);\n" +
    `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, keys }) + '\\n');\n` +
    // Add tracing inside the observer, after production has scrubbed inherited credential tracing.
    (trace ? `process.env.GIT_TRACE2_EVENT = ${JSON.stringify(trace)};\n` : '') +
    `process.exit(cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);\n`, { mode: 0o755 });
  return { env: { PATH: `${bin}:${process.env.PATH}` },
    calls: () => readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

function fixture(options = {}) {
  const calls = [], writes = [], diagnostics = [];
  const declaration = resolveOperation(options.name ?? 'verify').declaration;
  const cache = { remote: 'fixture-origin', ref: 'abc', time: 1000, ...options.cache };
  const io = {
    env: options.env ?? {}, now: () => options.time ?? 1001,
    diagnostic: line => diagnostics.push(line),
    filesystem: {
      realpathSync: p => options.realpath?.(p) ?? p,
      readFileSync: () => options.corrupt ? '{' : JSON.stringify(cache),
      writeFileSync: (...args) => writes.push(args), renameSync: (...args) => writes.push(args), rmSync: () => {},
    },
    git: (args, cwd) => {
      calls.push({ args, cwd });
      if (options.emptyGit) return '';
      if (args[0] === options.fail) throw new Error('fixture failure');
      if (args.includes('--show-toplevel')) return options.root ?? '/workspace/repo';
      if (args.includes('--absolute-git-dir')) return '/workspace/repo/.git';
      if (args[0] === 'remote') return 'fixture-origin';
      if (args[0] === 'rev-list') return options.count ?? '0';
      return 'abc';
    },
  };
  return { calls, writes, diagnostics, run: () => assertRunnerFreshness({ declaration,
    moduleUrl: 'file:///loaded/scripts/operations/run.mjs', zeroWrites: options.zeroWrites }, io) };
}

describe('runner freshness policy', () => {
  it.each([false, true])('freshness fetch permits credential helpers only outside a lane (lane=%s)', async laneRunner => {
    await withBareOrigin(async ctx => {
      const pool = join(ctx.tmp, 'pool');
      let cwd = ctx.clone;
      if (laneRunner) {
        ctx.git(['push', 'origin', 'HEAD:lane/target']);
        const at = ctx.git(['rev-parse', 'HEAD']).trim();
        ctx.git(['checkout', '--detach', '--quiet', at]);
        cwd = join(pool, 'repo', 'lane-1');
        mkdirSync(join(pool, 'repo'), { recursive: true });
        renameSync(ctx.clone, cwd);
        writeFileSync(join(cwd, '.git', '.lane-lease'), JSON.stringify({ session: 'holder',
          acquiredAt: new Date().toISOString(), at, branch: 'lane/target' }));
      }
      const observer = recordingGit(ctx);
      expect(assertRunnerFreshness({ declaration: resolveOperation(laneRunner ? 'open-pr' : 'verify').declaration,
        moduleUrl: pathToFileURL(join(cwd, 'run.mjs')).href }, {
        env: { ...process.env, ...observer.env, LANE_POOL_ROOT: pool, WE_DAEMON_MANAGED_CLONE: '', WE_OPERATION_ALLOW_STALE: '' },
      })).toEqual(laneRunner ? { exempt: true } : { behind: 0, uncertainty: '' });
      const fetches = observer.calls().filter(call => call.args.includes('fetch'));
      expect(fetches).toHaveLength(1);
      const keys = fetches[0].keys;
      expect(keys.includes('credential.helper')).toBe(laneRunner);
      expect(keys.includes('core.askPass')).toBe(laneRunner);
      expect(keys).toContain('core.hooksPath');
    });
  });
  it.each([
    ['attached', 'absent', true], ['attached', 'malformed', true],
    ['attached', 'ordinary', true], ['attached', 'pinned', false],
    ['detached', 'absent', false], ['detached', 'malformed', false],
    ['detached', 'ordinary', true], ['detached', 'pinned', true],
  ])('open-pr real lane regression matrix: %s HEAD, %s lease (exempt=%s)', async (head, kind, exempt) => {
    await withBareOrigin(async ctx => {
      ctx.git(['push', 'origin', 'HEAD:lane/target']);
      const at = ctx.git(['rev-parse', 'HEAD']).trim();
      if (head === 'detached') ctx.git(['checkout', '--detach', '--quiet', at]);
      const pool = join(ctx.tmp, 'pool'), lane = join(pool, 'repo', 'lane-1');
      mkdirSync(join(pool, 'repo'), { recursive: true });
      renameSync(ctx.clone, lane);
      if (kind !== 'absent') {
        const ordinary = { session: 'holder', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
        writeFileSync(join(lane, '.git', '.lane-lease'), kind === 'malformed' ? '{' :
          JSON.stringify(kind === 'pinned' ? { ...ordinary, at, branch: 'lane/target' } : ordinary));
      }
      const check = () => assertRunnerFreshness({ declaration: resolveOperation('open-pr').declaration,
        moduleUrl: pathToFileURL(join(lane, 'run.mjs')).href }, {
        env: { ...process.env, LANE_POOL_ROOT: pool, WE_OPERATION_ALLOW_STALE: '1' },
      });
      if (exempt) expect(check()).toEqual({ exempt: true });
      else expect(check).toThrow(/Refusing open-pr pinned runner/);
    });
  });
  it('pinned runner fetch never runs a lane-configured upload-pack or follows a lane URL rewrite', async () => {
    await withBareOrigin(async ctx => {
      ctx.git(['push', 'origin', 'HEAD:lane/target']);
      const at = ctx.git(['rev-parse', 'HEAD']).trim();
      const originUrl = ctx.git(['remote', 'get-url', 'origin']).trim();
      // A decoy whose lane/target differs: following the rewrite would read the wrong tip.
      const decoy = join(ctx.tmp, 'decoy.git');
      execFileSync('git', ['clone', '--quiet', '--bare', originUrl, decoy]);
      const marker = join(ctx.tmp, 'upload-pack-ran'), uploadPack = join(ctx.tmp, 'marker-upload-pack');
      writeFileSync(uploadPack, `#!/bin/sh\necho ran > '${marker}'\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
      ctx.git(['checkout', '--detach', '--quiet', at]);
      ctx.git(['config', 'remote.origin.uploadpack', uploadPack]);
      ctx.git(['config', `url.${decoy}.insteadOf`, originUrl]);
      ctx.git(['commit', '--allow-empty', '-m', 'decoy tip', '--quiet']);
      execFileSync('git', ['-C', ctx.clone, 'push', '--quiet', '--force', decoy, 'HEAD:refs/heads/lane/target']);
      ctx.git(['checkout', '--detach', '--quiet', at]);
      const pool = join(ctx.tmp, 'pool'), lane = join(pool, 'repo', 'lane-1');
      mkdirSync(join(pool, 'repo'), { recursive: true });
      renameSync(ctx.clone, lane);
      writeFileSync(join(lane, '.git', '.lane-lease'), JSON.stringify({ session: 'holder',
        acquiredAt: new Date().toISOString(), ttlMinutes: 240, at, branch: 'lane/target' }));
      const observer = recordingGit(ctx);
      expect(assertRunnerFreshness({ declaration: resolveOperation('open-pr').declaration,
        moduleUrl: pathToFileURL(join(lane, 'run.mjs')).href }, {
        env: { ...process.env, ...observer.env, LANE_POOL_ROOT: pool, WE_OPERATION_ALLOW_STALE: '' },
      })).toEqual({ exempt: true });
      expect(existsSync(marker)).toBe(false);
      const fetch = observer.calls().find(call => call.args.includes('fetch'));
      expect(fetch.args).toContain('--upload-pack=git-upload-pack');
      expect(fetch.args).toContain('protocol.ext.allow=never');
      expect(() => execFileSync('git', ['-C', lane, 'config', '--get-regexp', '^url\\.'], { stdio: 'pipe' })).toThrow();
    });
  });
  it('scrubs repository redirection and disables lane-config executable helpers on real Git calls', async () => {
    await withBareOrigin(async ctx => {
      ctx.git(['config', 'core.fsmonitor', 'false']);
      ctx.git(['config', 'core.hooksPath', '/does-not-exist']);
      ctx.git(['config', 'core.sshCommand', 'exit 99']);
      expect(assertRunnerFreshness({ declaration: resolveOperation('verify').declaration,
        moduleUrl: pathToFileURL(join(ctx.clone, 'run.mjs')).href }, {
        env: { ...process.env, GIT_DIR: '/missing-git-dir', GIT_WORK_TREE: '/missing-work-tree',
          GIT_INDEX_FILE: '/missing-index', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
          LANE_POOL_ROOT: join(ctx.tmp, 'pool'), WE_DAEMON_MANAGED_CLONE: '', WE_OPERATION_ALLOW_STALE: '' },
      })).toEqual({ behind: 0, uncertainty: '' });
    });
  });
  it.each(['runner', 'dispatch'])('%s freshness cannot launch automatic maintenance even when the checkout enables it', async kind => {
    await withBareOrigin(async ctx => {
      ctx.git(['config', 'maintenance.auto', 'true']);
      ctx.git(['config', 'gc.auto', '1']);
      const trace = join(ctx.tmp, 'freshness-git.jsonl');
      const observer = kind === 'runner' ? recordingGit(ctx, trace) : null;
      const env = { ...process.env, WE_OPERATION_ALLOW_STALE: '', WE_DAEMON_MANAGED_CLONE: '',
        ...observer?.env, LANE_POOL_ROOT: join(ctx.tmp, 'pool'), GIT_TRACE2_EVENT: trace };
      if (kind === 'runner') {
        const result = assertRunnerFreshness({ declaration: resolveOperation('verify').declaration,
          moduleUrl: pathToFileURL(join(ctx.clone, 'run.mjs')).href }, { env });
        expect(result).toEqual({ behind: 0, uncertainty: '' });
      } else {
        expect(checkMainStaleness({ run: args => gitRun(args, { cwd: ctx.clone, env }) }))
          .toMatchObject({ fresh: true, behind: 0 });
      }
      const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.some(e => e.event === 'start' && e.argv.includes('fetch'))).toBe(true);
      const children = events.filter(e => e.event === 'child_start');
      expect(children.some(e => e.argv.some(arg => ['maintenance', 'gc', 'repack'].includes(arg)))).toBe(false);
    });
  });
  it('classifies every registered declaration with the explicit verify exception', () => {
    const names = Object.keys(OPERATIONS).sort();
    expect(names).toMatchInlineSnapshot(`
      [
        "adoption-matrix",
        "agent-activity",
        "ai-routing",
        "brief-mode",
        "build-priority-set",
        "capacity-calendar",
        "ci-heal-reset",
        "claim",
        "clear-claim",
        "clear-stuck-session",
        "close-items",
        "codex-audit",
        "daemon-status",
        "delivery-capacity",
        "delivery-flow",
        "dispatch-eligibility",
        "dispatch-lane",
        "docket-refresh",
        "explore",
        "extend-rounds",
        "file-held-cards",
        "file-item",
        "free-scope",
        "gap-sweep-status",
        "gate-health",
        "graduate-chain",
        "graduation-progress-report",
        "grant-rounds",
        "health-respond",
        "heavy-queue",
        "host-capacity",
        "item-activity",
        "judge-sweep-facts",
        "land-advance",
        "land-human-only",
        "live-state",
        "live-work",
        "maintenance",
        "manual-daemon-pass",
        "mutation-check",
        "open-pr",
        "operator-override-show",
        "operator-session-bootstrap",
        "perf-snapshot",
        "pr-ownership",
        "pr-reconcile",
        "pr-size",
        "pr-status",
        "pr-sweep",
        "pr-trace",
        "pre-pr-check",
        "priority-sync",
        "prototype-load",
        "rearm",
        "record-referral-ruling",
        "record-verdict",
        "refresh",
        "reopen-items",
        "resolve",
        "resource-status",
        "restart-runner",
        "retry-prepare",
        "revert-red-check",
        "review-pr",
        "review-prep",
        "review-seat-caps",
        "route-pr-outcome",
        "routing-override",
        "runner-activity",
        "scaffold",
        "sessions",
        "stage-pr-view",
        "stale-state",
        "suggest-next",
        "telemetry-summary",
        "unpark",
        "update-branch",
        "urgent-sweep",
        "urgent-verify",
        "verify",
        "why",
        "worker-capacity",
      ]
    `);
    for (const name of ['close-items', 'reopen-items', 'graduate-chain', 'prototype-load', 'routing-override', 'build-priority-set']) {
      expect(isReadOnlyOperation(resolveOperation(name).declaration), name).toBe(false);
    }
    for (const name of names) {
      const { declaration } = resolveOperation(name);
      expect(requiresFreshRunner(declaration), name).toBe(name === 'verify' || !isReadOnlyOperation(declaration));
    }
  });
  it('uses loaded module root, caches a successful fetch, and never changes working tree', () => {
    const f = fixture({ corrupt: true });
    f.run();
    expect(f.calls[0].cwd).toBe('/loaded/scripts/operations');
    expect(f.calls.slice(1).every(c => c.cwd === '/workspace/repo')).toBe(true);
    expect(f.calls.find(c => c.args[0] === 'fetch').args).toEqual(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    expect(f.writes).toHaveLength(2);
    expect(f.calls.every(c => ['rev-parse', 'remote', 'fetch', 'rev-list'].includes(c.args[0]))).toBe(true);
  });
  it('cache hit avoids fetching', () => {
    const f = fixture(); f.run();
    expect(f.calls.some(c => c.args[0] === 'fetch')).toBe(false);
    expect(f.writes).toEqual([]);
  });
  for (const options of [{ time: 1000 + FRESHNESS_TTL }, { corrupt: true }, { cache: { time: 2000 } },
    { cache: { remote: 'other' } }, { cache: { ref: 'other' } }]) {
    it(`refreshes invalid cache ${JSON.stringify(options)}`, () => {
      const f = fixture(options); f.run();
      expect(f.calls.some(c => c.args[0] === 'fetch')).toBe(true);
    });
  }
  for (const options of [{ emptyGit: true }, { fail: 'fetch', corrupt: true }, { fail: 'rev-list' }, { count: 'NaN' }, { fail: 'rev-parse' }]) {
    it(`fails closed on uncertainty ${JSON.stringify(options)}`, () => {
      const f = fixture(options);
      expect(f.run).toThrow(/freshness uncertain/);
      expect(f.writes).toEqual([]);
      const reader = fixture({ ...options, name: 'stale-state' });
      reader.run(); expect(reader.diagnostics).toHaveLength(1);
    });
  }
  it('warns once without writes or fetch for stale zero-write readers', () => {
    const f = fixture({ name: 'stale-state', zeroWrites: true, corrupt: true, count: '4' });
    f.run(); expect(f.diagnostics).toHaveLength(1);
    expect(f.diagnostics[0]).toMatch(/4 commits behind.*uncertain/);
    expect(f.writes).toEqual([]);
    expect(f.calls.some(c => c.args[0] === 'fetch')).toBe(false);
  });
  for (const value of ['', 'true', '0', '01']) {
    it(`does not grant override for ${JSON.stringify(value)}`, () => {
      expect(fixture({ count: '2', env: { WE_OPERATION_ALLOW_STALE: value } }).run).toThrow(/2 commits behind.*run from a lane/);
    });
  }
  it('audits exact override for both stale and unknown states', () => {
    for (const options of [{ count: '2' }, { fail: 'fetch', corrupt: true }, {}]) {
      const f = fixture({ ...options, env: { WE_OPERATION_ALLOW_STALE: '1' } }); f.run();
      expect(f.diagnostics).toHaveLength(1);
      expect(f.diagnostics[0]).toMatch(/override: verify: runner .*HEAD .*refs\/remotes\/origin\/main/);
    }
  });
  it('exempts only real lane slots and exact daemon signal', () => {
    for (const options of [{ root: '/pool/we/lane-2', env: { LANE_POOL_ROOT: '/pool' } },
      { env: { WE_DAEMON_MANAGED_CLONE: '1' } },
      { root: '/alias', env: { LANE_POOL_ROOT: '/pool' }, realpath: p => p === '/alias' ? '/pool/we/lane-2' : p }]) {
      const f = fixture({ ...options, count: '2' }); expect(f.run()).toEqual({ exempt: true });
      expect(f.calls).toHaveLength(1);
    }
    for (const root of ['/pool/we/lane-2/nested', '/pool-other/we/lane-2', '/workspace/lane-2']) {
      expect(fixture({ root, count: '2', env: { LANE_POOL_ROOT: '/pool', WE_DAEMON_MANAGED_CLONE: 'true' } }).run).toThrow();
    }
  });
  it('independent dispatch refusal remains authoritative', () => {
    expect(() => cliPreflight('dispatch-lane', { arm: () => {}, assertFresh: () => { throw new Error('dispatch refusal'); } })).toThrow('dispatch refusal');
  });

  describe('codex-audit --json', () => {
    const SHA = 'a'.repeat(40), HEAD = 'b'.repeat(40);
    const deps = (answer, out = []) => ({ resolveSha: ref => (ref === HEAD ? HEAD : SHA), runCodex: () => answer,
      appendRecord: async () => {}, now: () => '2026-11-02T00:00:00Z', stdout: t => out.push(t), stderr: () => {} });
    const run = async (answer, json) => {
      const written = [];
      const auditDeps = { ...deps(answer, written), stderr: t => written.push(t), appendRecord: vi.fn() };
      const sink = createCodexAuditSink({ makeDeps: () => auditDeps });
      const binding = resolveOperation('codex-audit');
      const outcome = await runOperationCli({ ...binding, sinks: { 'codex-audit.run': sink },
        argv: ['--base=m', `--head=${HEAD}`, ...(json ? ['--json'] : [])],
        store: createMemoryRunStore(), newRunId: () => 'audit-output',
      });
      return { written, verdict: outcome.run.verdict, records: auditDeps.appendRecord.mock.calls,
        out: finishCodexAudit({ ...outcome, json }) };
    };
    it('json mode: nothing is written by the sink and stdout is only the parseable envelope', async () => {
      const { written, verdict, records, out } = await run('NOT WEAKENED\n', true);
      expect(written).toEqual([]);
      expect(out.code).toBe(0);
      expect(out.lines).toHaveLength(1);
      const env = JSON.parse(out.lines[0]);
      expect(env.verdict).toEqual({ ok: true, code: 0, stdout: 'NOT WEAKENED\n', stderr: '' });
      expect(records).toEqual([[expect.objectContaining({ verdict: 'NOT WEAKENED', base: SHA, head: HEAD, findings: [] })]]);
      expect(verdict.code).toBe(0);
    });
    it('json mode carries WEAKENED findings and a nonzero code', async () => {
      const { written, records, out } = await run('WEAKENED\nrun.mjs:1 loosened\n', true);
      expect(out.code).toBe(1);
      expect(written).toEqual([]);
      expect(JSON.parse(out.lines[0]).verdict).toEqual({ ok: false, code: 1,
        stdout: 'WEAKENED\nrun.mjs:1 loosened\n', stderr: '' });
      expect(records).toEqual([[expect.objectContaining({ verdict: 'WEAKENED', findings: ['run.mjs:1 loosened'] })]]);
    });
    it('plain mode is unchanged: verdict then findings lines, no JSON', async () => {
      const { out } = await run('WEAKENED\nrun.mjs:1 loosened\n', false);
      expect(out.lines.join('\n')).toBe('WEAKENED\nrun.mjs:1 loosened');
    });
    it('an incomplete audit keeps its code and returns its diagnostic in the operations envelope', async () => {
      const { written, records, out } = await run(undefined, true);
      expect(out.code).toBe(3);
      expect(written).toEqual([]);
      expect(records).toEqual([]);
      expect(out.lines).toHaveLength(1);
      expect(JSON.parse(out.lines[0]).verdict).toEqual({ ok: false, code: 3, stdout: '',
        stderr: 'UNPARSEABLE audit: incomplete or failed evidence; retry or request human review of the full diff.\n' });
    });
    it.each([
      ['NOT WEAKENED', [], 0],
      ['WEAKENED', ['run.mjs:1 loosened'], 1],
    ])('registered CLI --json emits only the %s envelope', async (verdict, findings, code) => {
      const written = [];
      const injectedDeps = { ...deps([verdict, ...findings].join('\n'), written),
        stderr: text => written.push(String(text)), appendRecord: vi.fn() };
      const auditDeps = vi.spyOn(auditIo, 'createAuditDeps').mockReturnValue(injectedDeps);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(text => {
        written.push(String(text));
        return true;
      });
      try {
        const binding = resolveOperation('codex-audit');
        const outcome = await runOperationCli({
          ...binding, argv: ['--base=m', `--head=${HEAD}`, '--json'],
          store: createMemoryRunStore(), newRunId: () => 'audit-json-regression',
        });
        expect(auditDeps).toHaveBeenCalledOnce();
        const captured = { ok: code === 0, code, stdout: `${[verdict, ...findings].join('\n')}\n`, stderr: '' };
        expect(outcome.run.verdict).toEqual(captured);
        expect(injectedDeps.appendRecord).toHaveBeenCalledOnce();
        expect(injectedDeps.appendRecord).toHaveBeenCalledWith(expect.objectContaining({
          verdict, findings, base: SHA, head: HEAD,
        }));
        expect(written).toEqual([]);
        const output = binding.finish({ ...outcome, json: true });
        expect(output.code).toBe(code);
        process.stdout.write(`${output.lines.join('\n')}\n`);
        expect(JSON.parse(written.join(''))).toMatchObject({ op: 'codex-audit', verdict: captured });
      } finally {
        stdout.mockRestore();
        auditDeps.mockRestore();
      }
    });
    it('captures both streams without mutating injected dependencies', async () => {
      const stdout = vi.fn(), stderr = vi.fn();
      const auditDeps = Object.freeze({ stdout, stderr });
      const sink = createCodexAuditSink({ makeDeps: () => auditDeps,
        auditMain: async (_argv, io) => { io.stdout('partial\n'); io.stderr('refused\n'); return 3; },
      });
      const verdict = await sink({ base: 'm', head: HEAD });
      expect(verdict).toEqual({ ok: false, code: 3, stdout: 'partial\n', stderr: 'refused\n' });
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(finishCodexAudit({ run: { verdict }, code: 0, lines: [], json: false }))
        .toEqual({ code: 3, lines: ['partial', 'refused'] });
    });
    it.each([true, false])('preserves adapter diagnostics when no audit verdict exists (json=%s)', json => {
      expect(finishCodexAudit({ run: {}, code: 1, lines: ['adapter refusal'], json }))
        .toEqual({ code: 1, lines: ['adapter refusal'] });
    });
  });
});
