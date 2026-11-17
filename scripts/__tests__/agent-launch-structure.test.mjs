import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { AGENT_LAUNCH_ALLOWLIST, findAgentLaunches, readAgentLaunchTree } from '../lib/agent-launch-structure.mjs';

describe('single agent launch boundary', () => {
  it('permits only agent-launch.mjs throughout scripts/ and skills-src/', () => {
    expect(AGENT_LAUNCH_ALLOWLIST).toEqual(['scripts/lib/agent-launch.mjs']);
    expect(findAgentLaunches(readAgentLaunchTree(resolve(import.meta.dirname, '../..')))).toEqual([]);
  }, 60_000);

  const forbidden = {
    direct: "spawn('claude', ['-p', 'hello'])",
    synchronous: "spawnSync('codex', ['exec', 'hello'])",
    exec: "exec('claude -p hello')",
    execFile: "execFile('claude', ['agents', '--json'])",
    execFileSync: "execFileSync('codex', ['exec', 'hello'])",
    fork: "fork('claude', [])",
    member: "cp.spawn('claude', [])",
    childProcessMember: "child_process.execFile('codex', ['exec'])",
    computedMember: "cp['spawnSync']('claude', [])",
    alias: "const s = spawn; s('claude', [])",
    aliasChain: "const s = cp.spawn; const ss = s; ss('codex', [])",
    importedAlias: "import { spawn as sp } from 'node:child_process'; sp('claude', [])",
    constant: "const CLI = 'claude'; spawn(CLI, [])",
    constantAlias: "const C = 'codex'; const CLI = C; cp.execFile(CLI, [])",
    template: 'spawn(`claude`, [])',
    templateShell: 'spawn("sh", ["-c", `claude -p ${prompt}`])',
    shell: "spawn('sh', ['-c', 'codex exec hello'])",
    shellConstant: "const SCRIPT = 'claude agents --json'; execFile('/bin/bash', ['-lc', SCRIPT])",
    array: "const CMD = ['codex', 'exec']; spawn(CMD[0], CMD.slice(1))",
    arrayCommand: "run(['claude', '-p', 'hello'])",
    runFn: "runFn('claude', ['stop', id])",
    injectedDefault: "function f({ spawnFn = spawn } = {}) { spawnFn('claude', []) }",
    injectedAliasDefault: "function f({ run: r = cp.execFileSync } = {}) { r('codex', ['exec']) }",
    commandDefault: "function f({ cli = 'codex', spawnFn = spawn } = {}) { spawnFn(cli, []) }",
    objectConstant: "const BINS = { primary: 'claude' }; cp.execFile(BINS.primary, [])",
    frozenRegistry: "const BINS = Object.freeze({ codex: 'codex' }); spawnSync(BINS['codex'], [])",
    builder: "function command() { return { cmd: 'claude', args: ['-p'] }; } const { cmd, args } = command(); spawn(cmd, args)",
  };
  it.each(Object.entries(forbidden))('rejects the %s bypass', (_name, source) => {
    expect(findAgentLaunches({ 'scripts/forbidden.mjs': source })).not.toEqual([]);
  });

  it('resolves command constants imported from another file', () => {
    expect(findAgentLaunches({ 'scripts/cli.mjs': "export const CLI = 'claude';",
      'skills-src/task/run.mjs': "import { CLI as bin } from '../../scripts/cli.mjs'; import {spawn as s} from 'node:child_process'; s(bin, [])" })).toHaveLength(1);
  });
  it('fails closed when a source cannot be parsed', () => {
    expect(findAgentLaunches({ 'scripts/broken.mjs': "spawn('claude', [" })).toMatchObject([{ reason: expect.stringContaining('unparseable') }]);
  });
  it('allows unrelated processes, shadowed constants, comments, and launcher calls', () => {
    expect(findAgentLaunches({ 'scripts/ok.mjs': `
      import {launchAgent} from './lib/agent-launch.mjs';
      const CLI = 'claude';
      function f() { const CLI = 'node'; spawn(CLI, ['script.mjs']); }
      // cp.spawn('claude', [])
      const help = "run('codex', ['exec'])";
      launchAgent({mode: 'claude-print', resumeId: null}, spawn, CLI, ['-p', 'hi']);
    ` })).toEqual([]);
  });
});
