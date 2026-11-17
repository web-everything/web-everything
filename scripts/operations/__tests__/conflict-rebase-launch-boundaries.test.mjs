import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { assertFixerLaunch, launchGuardFor } from '../../conveyor/conflict-rebase-launch-gate.mjs';
import { defaultSpawnAgent, spawnAgentToCompletion, defaultClaudeProvider } from '../dispatch-lane-io.mjs';
import { defaultSpawnCodexAgent } from '../codex-delivery-provider.mjs';
import { fixDetachedProvider } from '../dispatch-providers/fix.mjs';
import { parseFixRunArgv } from '../fix-run.mjs';
import { launchWrappedClaudeWorker } from '../worker-wrapper-launch.mjs';

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
    expect(defaultSpawnAgent(['--bg', 'brief'], { cwd: '/lane' }, { exec })).toBe('started');
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
