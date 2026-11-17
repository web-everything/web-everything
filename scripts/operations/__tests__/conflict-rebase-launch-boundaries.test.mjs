import { auditLaunchBoundaries } from './launch-boundary-audit.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { assertFixerLaunch, launchGuardFor, FIXER_LAUNCH_MODES } from '../../conveyor/conflict-rebase-launch-gate.mjs';
import { defaultSpawnAgent, spawnAgentToCompletion, defaultClaudeProvider } from '../dispatch-lane-io.mjs';
import { defaultSpawnCodexAgent } from '../codex-delivery-provider.mjs';
import { DELIVERY_AGENT_PROVIDERS } from '../deliver-item-wrapper.mjs';
import { fixDetachedProvider } from '../dispatch-providers/fix.mjs';
import { parseFixRunArgv } from '../fix-run.mjs';
import { launchWrappedClaudeWorker } from '../worker-wrapper-launch.mjs';
import { execGuardedFixer } from '../fixer-process.mjs';

const head = 'a'.repeat(40);
const planned = { mode: 'conflict-rebase', pr: 7, headRefOid: head,
  conflictRebase: { oldHead: head, defaultBranch: 'main' } };
const guard = launchGuardFor(planned, { repo: 'o/r' });
const live = () => ({ headRefOid: head, state: 'OPEN', isDraft: false, baseRefName: 'main',
  mergeable: 'CONFLICTING', labels: ['review:pending'] });
const refused = expect.objectContaining({ kind: 'conflict-rebase-launch-refused' });

describe('lowest fixer execution authority', () => {
  it('trust-grant retry re-gates and refuses a hold arriving after the first attempt', () => {
    let state = live();
    const exec = vi.fn(() => { throw Object.assign(new Error('trust'), { stderr: 'Workspace not trusted' }); });
    const gate = vi.fn((request, options) => assertFixerLaunch(request, { ...options, readLive: () => state }));
    const grantTrust = vi.fn(() => { state = { ...state, labels: ['review:pending', 'review:held-mechanical'] }; });
    expect(() => defaultSpawnAgent(['--bg', 'brief'], { cwd: '/lane', mode: planned.mode, launchGuard: guard },
      { exec, gate, grantTrust })).toThrow(refused);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(grantTrust).toHaveBeenCalledOnce();
  });

  it.each([
    ['no guard', undefined],
    ['no guard mode', { ...guard, mode: undefined }],
    ['no pin', { ...guard, pinnedHead: undefined }],
    ['bad pin', { ...guard, pinnedHead: 'unknown' }],
    ['no PR', { ...guard, pr: undefined }],
    ['no repository', { ...guard, repo: undefined }],
  ])('refuses %s before any synchronous process execution', (_name, launchGuard) => {
    const exec = vi.fn();
    expect(() => defaultSpawnAgent(['--bg', 'brief'], { mode: 'conflict-rebase', launchGuard }, { exec }))
      .toThrow(refused);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([spawnAgentToCompletion, defaultSpawnCodexAgent])('async execution refuses missing evidence with zero launches', async spawn => {
    const spawnFn = vi.fn();
    await expect(spawn(['brief'], { mode: 'conflict-rebase' }, { spawnFn })).rejects.toThrow(refused);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('unreadable live state refuses with zero launches and an operator retry instruction', () => {
    const exec = vi.fn();
    expect(() => defaultSpawnAgent(['--bg', 'brief'], { mode: planned.mode, launchGuard: guard,
      launchGateOptions: { readLive: () => { throw new Error('unreadable'); } } }, { exec }))
      .toThrow(/refresh PR evidence before retrying/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('non-conflict launches preserve process options and need no guard', () => {
    const exec = vi.fn(() => 'started');
    expect(defaultSpawnAgent(['--bg', 'brief'], { cwd: '/lane', mode: 'ordinary', launchGuard: null }, { exec })).toBe('started');
    expect(exec.mock.calls[0][2]).not.toHaveProperty('launchGuard');
    expect(exec.mock.calls[0][2]).not.toHaveProperty('mode');
  });

  it('borrowed launcher round-trips the original mode and pin through CLI argv', () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));
    fixDetachedProvider({ pr: 7, sessionSlug: 'fix-7', mode: planned.mode, launchGuard: guard,
      promptFile: '/brief', ref: 'lane/fix', policyRoute: { provider: 'codex' } },
    { spawnDetached, logPathFor: () => '/log', readDeliveryAgentMarker: () => null });
    expect(parseFixRunArgv(spawnDetached.mock.calls[0][0].slice(1)))
      .toMatchObject({ mode: planned.mode, launchGuard: guard });
  });

  it('provider and wrapper spec retain the original conflict evidence', () => {
    const launch = vi.fn(() => ({ wrapperPid: 123 }));
    const launchWrapped = request => launchWrappedClaudeWorker({ ...request, launch, specDir: '/specs' });
    defaultClaudeProvider({ mode: planned.mode, launchGuard: guard, launchKind: 'fix', pr: 7,
      sessionSlug: 'fix-7', sessionId: '12345678-1234-4234-8234-123456789abc', cwd: '/lane', prompt: 'brief' },
    { wrapKind: () => true, launchWrapped });
    expect(launch.mock.calls[0][0]).toMatchObject({ mode: planned.mode, launchGuard: guard });
  });

  it('enumerates all process creation sites and requires the shared gate immediately before execution', () => {
    const expected = {
      'scripts/operations/fixer-process.mjs': ['exec', 'spawnToCompletion:command', 'execGuardedFixer:cmd'],
      'scripts/operations/dispatch-lane-io.mjs': ['spawnAgent:argv', "execGuardedFixer:'claude'", "spawnFixerToCompletion:'claude'"],
      'scripts/operations/explore-io.mjs': ["execGuardedFixer:'claude'", 'spawnAgent:argv'],
      'scripts/operations/worker-wrapper.mjs': ['execGuardedFixer:cmd', 'spawnToCompletionFn:spec.command'],
      'scripts/operations/codex-delivery-provider.mjs': ['spawnFixerToCompletion:CODEX_CLI'],
      // Include the generic git/gh/node command adapter so the raw exec inventory is explicit too.
      'scripts/operations/fix-run.mjs': ['execFileSync:cmd', 'execGuardedFixer:launch.provider', 'spawnCodex:argv', 'provider.spawn:request'],
      'scripts/operations/deliver-item-wrapper.mjs': ['provider.spawn:request', 'runWorkerFn:request', 'spawnAgent:a', 'spawnAgent:argv', 'spawnAgent:argv', 'provider.spawn:request', 'provider.spawn:request'],
    };
    for (const [file, sites] of Object.entries(expected)) {
      const source = readFileSync(file, 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const found = [];
      const visit = node => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(ast);
          const arg = node.arguments[0]?.getText(ast);
          const token = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : arg;
          const startsFixer = (callee === 'run' && ['claude', 'codex'].includes(token))
            || ['execGuardedFixer', 'spawnFixerToCompletion', 'spawnToCompletion', 'spawnToCompletionFn', 'provider.spawn', 'spawnCodex', 'spawnAgent', 'runWorkerFn'].includes(callee)
            || (['exec', 'spawn', 'spawnFn', 'execFileSync', 'execFile', 'spawnSync'].includes(callee)
              && (file.endsWith('fixer-process.mjs') || (['cmd', 'command', 'claude', 'codex', 'spec.command'].includes(token) || /CLAUDE|CODEX/.test(token ?? ''))));
          const isListing = token === 'claude' && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])
            && node.arguments[1].elements[0]?.getText(ast) === "'agents'";
          if (startsFixer && !isListing) {
            found.push(callee === 'exec' ? callee : `${callee}:${ts.isObjectLiteralExpression(node.arguments[0]) ? 'request' : arg}`);
            if (callee === 'exec') expect(source.slice(0, node.getStart(ast)).split('\n').slice(-2).join('\n'))
              .toContain('gate({ ...launchContext, mode, launchGuard }');
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(found, file).toEqual(sites);
    }
  });
});


function launchSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['__tests__', 'node_modules'].includes(entry.name)) return [];
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? launchSourceFiles(file) : /\.(?:mjs|cjs|js|ts|tsx)$/.test(file) ? [file] : [];
  });
}

it('audits every launch reference and aliased call in the whole scripts/ and skills-src/ trees', () => {
  const expected = JSON.parse(readFileSync('scripts/operations/__tests__/launch-boundary-sites.json', 'utf8'));
  const actual = {}, failures = [];
  for (const file of [...launchSourceFiles('scripts'), ...launchSourceFiles('skills-src')]) {
    const result = auditLaunchBoundaries(file, readFileSync(file, 'utf8'));
    failures.push(...result.failures);
    if (result.calls.length || result.references.length) actual[file] = { calls: result.calls, references: result.references };
  }
  expect(failures).toEqual([]);
  expect(actual).toEqual(expected); // A new reference needs explicit review, including unused aliases.
});

it.each([
  `import { defaultSpawnAgent } from './io.mjs'; defaultSpawnAgent([], {});`,
  `io.defaultSpawnAgent([], {});`,
  `obj['defaultSpawnAgent']([], {});`,
  `const { defaultSpawnAgent: x } = io; const next = x; next([], {});`,
  `import { defaultSpawnAgent as y } from './io.mjs'; y([], {});`,
  `function launch({ spawnAgent = defaultSpawnAgent } = {}) { spawnAgent([], {}); }`,
  `function launch(spawnAgent = io.defaultSpawnAgent) { spawnAgent([], {}); }`,
  `const x = io['execGuardedFixer']; x('claude', [], {});`,
  `const obj = { run: io.defaultSpawnAgent }; obj.run([], {});`,
  `let x; { x = io.defaultSpawnAgent; } x([], {});`,
  `let x = io.defaultSpawnAgent; x = custom; x([], {});`,
  `function launch({ defaultSpawnAgent: x }) { const y = x; y([], {}); }`,
  `import { spawnFixerToCompletion as x } from './process.mjs'; x('claude', [], {});`,
])('AST audit refuses a missing descriptor through %s', source => {
  const result = auditLaunchBoundaries('fixture.mjs', source);
  expect(result.calls).toHaveLength(1);
  expect(result.references.length).toBeGreaterThan(0);
  expect(result.failures).toHaveLength(1);
  expect(auditLaunchBoundaries('fixture.mjs', source.replaceAll('[], {}', "[], { mode: 'ordinary', launchGuard: null }")).failures).toEqual([]);
});

it.each([undefined, null, {}, { launchGuard: null }, { mode: 'unknown', launchGuard: null }, { mode: 'ordinary' }])(
  'defaultSpawnAgent refuses incomplete or unknown descriptor %j with a logged reason and zero executions', descriptor => {
    const exec = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => defaultSpawnAgent(['brief'], descriptor, { exec })).toThrow(refused);
      expect(exec).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('launch refused'));
    } finally { log.mockRestore(); }
  });


it.each([spawnAgentToCompletion, defaultSpawnCodexAgent])('streaming wrappers refuse missing/unknown descriptors without creating a child', async spawn => {
  for (const descriptor of [undefined, null, {}, { mode: 'unknown', launchGuard: null }]) {
    const spawnFn = vi.fn();
    await expect(spawn(['brief'], descriptor, { spawnFn })).rejects.toThrow(refused);
    expect(spawnFn).not.toHaveBeenCalled();
  }
});

it('an evidence persistence failure cannot enter the trust retry after process creation', () => {
  const exec = vi.fn(() => 'backgrounded · abcd1234');
  const grantTrust = vi.fn();
  expect(() => defaultSpawnAgent(['brief'], { cwd: '/lane', mode: 'ordinary', launchGuard: null }, {
    exec, grantTrust, saveEvidence: () => { throw Object.assign(new Error('write failed'), { stderr: 'Workspace not trusted' }); },
  })).toThrow('write failed');
  expect(exec).toHaveBeenCalledOnce();
  expect(grantTrust).not.toHaveBeenCalled();
});


it.each(['claude-restricted', 'codex'])('%s delivery resume retains saved conflict admission and refuses a new hold', async name => {
  let saved, state = live();
  const events = [];
  const exec = vi.fn(() => { events.push('exec'); return '{"type":"thread.started","thread_id":"thread-1"}\n'; });
  const provider = DELIVERY_AGENT_PROVIDERS[name];
  const request = { mode: planned.mode, launchGuard: guard, sessionId: 'session-7', sessionSlug: 'conveyor-7',
    prompt: 'brief', lane: 3, item: '7' };
  const io = {
    saveEvidence: (_id, descriptor) => { events.push('save'); saved = structuredClone(descriptor); },
    readSavedLaunch: () => { events.push('read'); return saved; },
    spawnAgent: async (argv, opts) => ({ stdout: defaultSpawnAgent(argv, { ...opts,
      launchGateOptions: { readLive: () => { events.push('gate'); return state; } },
    }, { exec, saveEvidence: () => {} }), stderr: '' }),
    resolveLane: () => '/lane', ensureSettingsFile: () => '/settings', resolveReportsDir: () => '/reports',
    stageDeliveryReportCli: () => {}, run: () => '', persistFailure: () => {}, recordCpu: () => {},
    workerWrapper: false, denyPaths: ['/primary/**'], readThreadId: () => 'thread-1', writeThreadId: () => {}, recordScorecard: () => {},
  };
  await provider.spawn(request, io);
  expect(saved).toEqual({ mode: planned.mode, launchGuard: guard });
  expect(events.slice(0, 4)).toEqual(['save', 'gate', 'gate', 'exec']);
  events.length = 0;
  exec.mockClear();
  state = { ...state, labels: ['review:pending', 'review:held-mechanical'] };
  await expect(provider.spawn({ ...request, mode: 'ordinary', launchGuard: null, resumeSessionId: request.sessionId }, io)).rejects.toThrow(refused);
  expect(events).toEqual(['read', 'gate']);
  expect(exec).not.toHaveBeenCalled();
});

it.each(['claude-restricted', 'codex'])('%s delivery resume refuses missing saved evidence with zero launches', async name => {
  const spawnAgent = vi.fn();
  await expect(DELIVERY_AGENT_PROVIDERS[name].spawn({ mode: 'build', launchGuard: null,
    sessionId: 'session-7', resumeSessionId: 'session-7', sessionSlug: 'conveyor-7', prompt: 'brief', lane: 3, item: '7',
  }, { spawnAgent, readSavedLaunch: () => undefined,
    resolveLane: () => '/lane', ensureSettingsFile: () => '/settings', resolveReportsDir: () => '/reports',
    stageDeliveryReportCli: () => {}, run: () => '', workerWrapper: false, denyPaths: ['/primary/**'], readThreadId: () => 'thread-1',
  })).rejects.toThrow(refused);
  expect(spawnAgent).not.toHaveBeenCalled();
});


it.each(FIXER_LAUNCH_MODES.filter(mode => mode !== 'conflict-rebase'))('explicit %s launches preserve non-conflict behavior without live PR reads', mode => {
  const readLive = vi.fn();
  expect(() => assertFixerLaunch({ mode, launchGuard: null }, { readLive })).not.toThrow();
  expect(readLive).not.toHaveBeenCalled();
});

it('the execution authority refuses a missing descriptor even when a live-gate seam returns', () => {
  const exec = vi.fn(), gate = vi.fn();
  expect(() => execGuardedFixer('claude', [], undefined, { exec, gate })).toThrow(refused);
  expect(exec).not.toHaveBeenCalled();
});
