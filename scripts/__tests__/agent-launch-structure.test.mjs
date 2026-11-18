import { describe, expect, it } from 'vitest';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { findAgentLaunches } from './fixtures/agent-launch-source.mjs';
import { AGENT_LAUNCH_ALLOWLIST, findAgentLaunches as scanAgentLaunches, readAgentLaunchTree } from '../lib/agent-launch-structure.mjs';


// Conservative may-execute scan, paired with the runtime assertion in agent-launch.mjs.
const root = resolve(import.meta.dirname, '../..');
// Production migration evidence pins each file's complete sorted call inventory and exact count.
// Hashing keeps opaque-callee evidence reviewable in size; there is no filename-only exemption.
function migrationEvidence(findings) {
  const grouped = new Map();
  for (const row of launchInventory(findings)) {
    if (!grouped.has(row.file)) grouped.set(row.file, []);
    grouped.get(row.file).push(row);
  }
  return [...grouped].map(([file, rows]) => ({ file,
    count: rows.reduce((count, row) => count + row.count, 0),
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  }));
}

function launchInventory(findings) {
  // Parse failures have no call kind and must never be exempted.
  expect(findings.filter(f => !f.kind), 'scanner must establish every call kind').toEqual([]);
  const counts = new Map();
  for (const finding of findings) {
    expect(finding).toMatchObject({ classification: expect.stringMatching(/^(resolved|unresolved)$/), fingerprint: expect.any(String) });
    const key = JSON.stringify({ file: relative(root, finding.file).replaceAll('\\', '/'), kind: finding.kind,
      classification: finding.classification, fingerprint: finding.fingerprint });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ ...JSON.parse(key), count }));
}
function assertAllowlist(findings, allowlist) {
  const inventory = launchInventory(findings);
  expect(inventory, 'update the migration allowlist: new bypass or stale exemption').toEqual(allowlist);
}

describe('single agent launch boundary', () => {
  it.each([
    ...["spawn('npx', ['claude'])", "spawn('pnpm', ['exec', 'codex'])",
      "spawn('custom-wrapper', ['claude'])", "spawn('echo x; claude', [], {shell:true})",
      "exec('echo x; claude')", "execSync('echo x; codex')",
      "spawn('custom', ['echo x; codex'], {shell:true})"].map(source => ({ name: `R37.6 literal agent word: ${source}`, source, refused: true })),
    { name: 'R37.6 unrelated literal wrapper control', source: "spawn('npx', ['unrelated-tool'])" },
    { name: 'R37.6 agent name substring control', source: "spawn('custom', ['claude-tools', 'mycodex'], {shell:true})" },
    ...[
      "import {spawn as start} from 'node:child_process'; start('claude',[])",
      "import {spawn} from 'child_process'; const start=spawn; start('claude',[])",
      "import * as cp from 'node:child_process'; const start=cp.spawn; start('codex',[])",
      "import cp from 'child_process'; const {spawn:start}=cp; start('claude',[])",
      "const {spawn:start}=require('node:child_process'); start('claude',[])",
      ...['flag ? spawn : console.log', 'flag ? console.log : spawn', 'spawn || console.log',
        'console.log && spawn', 'console.log ?? spawn', 'spawn && console.log', 'spawn ?? console.log']
        .map(expression => `const start=${expression}; start('claude',[])`),
      "import {spawn as start} from 'node:child_process'; const f=flag ? console.log : start; f('claude',[])",
      "let f=console.log; f=flag ? spawn : console.log; f('claude',[])",
    ].map(source => ({ name: `R37.7 primitive provenance: ${source}`, source, refused: true })),
    { name: 'R37.7 non-primitive conditional control', source: "const f=flag ? console.log : console.info; f('claude',[])" },
    ...[
      "function factory(){return spawn} const start=factory(); start('claude',[])",
      "function factory(){return spawn} factory()('claude',[])",
      "function factory(){return () => spawn} const start=factory()(); start('git',[])",
      "function invoke(start){start('git',[])} invoke(spawn)",
      "const start = opaque(); start('git',[])",
      "function factory(){return spawn}",
      "function store(){ const saved=spawn; }",
      "function store(){ const {spawn:start}=cp; }",
      "function pass(){ accept(spawn); }",
      "export const start=spawn",
      "export {spawn as start} from 'node:child_process'",
      "function invoke(){ const saved={start:spawn}; return saved; }",
      "function relay(start){ return () => start('git',[]) }",
      "const registry={}; registry.start=spawn; registry.start('git',[])",
      "import cp from 'node:child_process'; const other=cp; other.spawn=opaque; cp.spawn('git',[])",
      "const start=flag?spawn:console.log; function factory(){return start}",
      "function invoke(start=console.log){start('git',[])}",
      "(flag ? spawn : opaque())('git',[])",
      "function invoke(start=spawn){start('git',[])}",
      "const start=spawn; export function factory(){return start}",
      "function pure(){return 'ok'} const start=opaque(pure); start('git',[])",
    ].map(source => ({ name: `R37.10 opaque callee or primitive escape: ${source}`, source, refused: true })),
    { name: 'R37.10 factory and returned callee each require review even for git',
      source: "function factory(){return spawn} const start=factory(); start('git',[])",
      potentialKinds: ['factory', 'start'], escape: true, refused: true },
    { name: 'R37.10 passed parameter callee requires review even for git',
      source: "function invoke(start){start('git',[])} invoke(spawn)",
      potentialKinds: ['start', 'invoke'], escape: true, refused: true },
    { name: 'R37.10 passing a reference is itself a finding',
      source: "function pass(){console.log(spawn)}", escape: true, refused: true },
    { name: 'R37.10 unbound primitive-name callee', source: "spawn('git',[])", bare: true, refused: true },
    { name: 'R37.10 unbound namespace-name callee', source: "cp.spawn('git',[])", bare: true, refused: true },
    { name: 'R37.10 local unrelated function control', source: "function start(){return 'ok'} start('claude',[])" },
    { name: 'R37.10 local unrelated closure control', source: "const start=() => console.log('ok'); start('claude',[])" },
    { name: 'R37.10 imported unrelated primitive-name control', source: "import {spawn} from 'unrelated'; spawn('claude',[])" },
    { name: 'R37.7 imported non-primitive control', source: "import {log as start} from 'node:console'; start('claude',[])" },
  ])('$name', ({ source, refused, bare, potentialKinds = [], escape }) => {
    const findings = (bare ? scanAgentLaunches : findAgentLaunches)({ 'scripts/r37-structure.mjs': source });
    if (refused) expect(findings.length).toBeGreaterThan(0);
    else expect(findings).toEqual([]);
    for (const kind of potentialKinds) expect(findings.some(f => f.kind === kind && /opaque callee/.test(f.reason))).toBe(true);
    if (escape) expect(findings.some(f => /primitive reference escapes/.test(f.reason))).toBe(true);
  });

  it.each([
    { name: 'R37.8 unresolved mutable initializer', before: "let command='git'; spawn(command,argv)", after: "let command='claude'; spawn(command,argv)" },
    { name: 'R37.8 unresolved assignment', before: "let command; command='git'; spawn(command,argv)", after: "let command; command='claude'; spawn(command,argv)" },
    { name: 'R37.8 transitive initializer', before: "let binary='git'; const command=binary; spawn(command,argv)", after: "let binary='claude'; const command=binary; spawn(command,argv)" },
    { name: 'R37.8 mutable argv initializer', before: "let argv=['git']; spawn(command,argv)", after: "let argv=['claude']; spawn(command,argv)" },
    { name: 'R37.8 member assignment', before: "const cfg={}; cfg.command='git'; spawn(cfg.command,argv)", after: "const cfg={}; cfg.command='claude'; spawn(cfg.command,argv)" },
    { name: 'R37.8 third argument binding', before: "let opts={shell:false}; spawn(command,argv,opts)", after: "let opts={shell:true}; spawn(command,argv,opts)" },
    { name: 'R37.8 shorthand argument binding', before: "let shell=false; spawn(command,argv,{shell})", after: "let shell=true; spawn(command,argv,{shell})" },
    ...[
      ["'git',[]", "'claude',['--resume','unchecked-id']"],
      ["command,[]", "command,['--resume','unchecked-id']"],
      ["'git',argv", "'claude',argv"],
    ].map(([before, after]) => ({name: `R37.11 generic wrapper caller inputs: ${before}`,
      before: `function invoke(command,argv){spawn(command,argv)} invoke(${before})`,
      after: `function invoke(command,argv){spawn(command,argv)} invoke(${after})`, generic: true})),
    { name: 'R37.11 generic wrapper caller binding definition',
      before: "function invoke(command,argv){spawn(command,argv)} let command='git'; invoke(command,[])",
      after: "function invoke(command,argv){spawn(command,argv)} let command='claude'; invoke(command,[])", generic: true },
    { name: 'R37.11 unchanged generic wrapper positive control',
      before: "function invoke(command,argv){spawn(command,argv)} invoke('git',[])",
      after: "\nfunction invoke(command,argv){spawn(command,argv)} invoke('git',[])", generic: true, same: true },
    { name: 'R37.8 unchanged binding positive control', before: "let command='git'; spawn(command,argv)", after: "\n\nlet command='git'; spawn(command,argv)", same: true },
    { name: 'R37.8 unrelated binding positive control', before: "let other='git'; spawn(command,argv)", after: "let other='claude'; spawn(command,argv)", same: true },
  ])('$name', ({ before, after, same, generic }) => {
    const allowed = launchInventory(findAgentLaunches({ 'scripts/r37-fingerprint.mjs': before }));
    expect(allowed).toHaveLength(generic ? 2 : 1);
    if (generic) expect(allowed.some(row => row.kind === 'invoke')).toBe(true);
    const changed = findAgentLaunches({ 'scripts/r37-fingerprint.mjs': after });
    if (same) assertAllowlist(changed, allowed);
    else {
      expect(changed[0].classification).toBe(allowed[0].classification);
      expect(() => assertAllowlist(changed, allowed)).toThrow();
    }
  });

  it('R37.11 pins transitive imported argument-builder inputs', () => {
    const consumer = "import {build} from './builder.mjs'; spawn(build(),argv)";
    const before = { 'scripts/builder.mjs': "let command='git'; export function build(){return command}",
      'scripts/consumer.mjs': consumer };
    const allowed = launchInventory(findAgentLaunches(before));
    expect(allowed).toHaveLength(1);
    const after = { ...before, 'scripts/builder.mjs': "let command='claude'; export function build(){return command}" };
    expect(() => assertAllowlist(findAgentLaunches(after), allowed)).toThrow();
  });

  it('R37.7 follows a renamed imported primitive through a local module', () => {
    expect(findAgentLaunches({ 'scripts/process.mjs': 'export const start = spawn;',
      'scripts/consumer.mjs': "import {start as go} from './process.mjs'; go('claude',[])" }).filter(f => f.kind === 'go')).toHaveLength(1);
    expect(findAgentLaunches({ 'scripts/process.mjs': 'export default spawn;',
      'scripts/consumer.mjs': "import go from './process.mjs'; go('claude',[])" }).filter(f => f.kind === 'go')).toHaveLength(1);
  });

  it.each(["import * as cp from './process.mjs'; const go=cp.start; go('claude',[])",
    "import {start as go} from './process.mjs'; go('claude',[])"])
  ('R37.7 resolves re-exported primitive provenance: %s', consumer => {
    expect(findAgentLaunches({ 'scripts/process.mjs': "export {spawn as start} from 'node:child_process';",
      'scripts/consumer.mjs': consumer }).filter(f => f.file.endsWith('/consumer.mjs') && f.kind === 'go')).toHaveLength(1);
  });

  it('R37.7 resolves a default-imported object member primitive', () => {
    expect(findAgentLaunches({ 'scripts/process.mjs': 'export default {start:spawn};',
      'scripts/consumer.mjs': "import cp from './process.mjs'; const go=cp['start']; go('claude',[])" }).filter(f => f.kind === 'go')).toHaveLength(1);
  });

  it('R37.8 pins imported unresolved binding definitions', () => {
    const consumer = "import {command} from './command.mjs'; spawn(command,argv)";
    const before = { 'scripts/command.mjs': "export let command='git'", 'scripts/consumer.mjs': consumer };
    const after = { ...before, 'scripts/command.mjs': "export let command='claude'" };
    const allowed = launchInventory(findAgentLaunches(before));
    expect(allowed).toHaveLength(1);
    expect(() => assertAllowlist(findAgentLaunches(after), allowed)).toThrow();
  });

  it.each(["import * as cli from './command.mjs'; spawn(cli.command,argv)",
    "import * as cli from './command.mjs'; spawn(cli[flag ? 'other' : 'command'],argv)",
    "import cli from './command.mjs'; spawn(cli['command'],argv)"])
  ('R37.8 pins namespace/default member definitions: %s', consumer => {
    const before = { 'scripts/command.mjs': "export let command='git'; export default {command}", 'scripts/consumer.mjs': consumer };
    const allowed = launchInventory(findAgentLaunches(before));
    expect(allowed).toHaveLength(1);
    expect(() => assertAllowlist(findAgentLaunches({ ...before, 'scripts/command.mjs': "export let command='claude'; export default {command}" }), allowed)).toThrow();
  });

  it('R37.8 pins a default object literal definition', () => {
    const consumer = "import cli from './command.mjs'; spawn(cli.command,argv)";
    const before = { 'scripts/command.mjs': "export default {command:'git'}", 'scripts/consumer.mjs': consumer };
    const allowed = launchInventory(findAgentLaunches(before));
    expect(allowed).toHaveLength(1);
    expect(() => assertAllowlist(findAgentLaunches({ ...before,
      'scripts/command.mjs': "export default {command:'claude'}" }), allowed)).toThrow();
  });

  it('permits exactly the unmigrated allowlist throughout scripts/ and skills-src/', () => {
    expect(AGENT_LAUNCH_ALLOWLIST).toEqual(['scripts/lib/agent-launch.mjs']);
    expect(migrationEvidence(scanAgentLaunches(readAgentLaunchTree(root)))).toMatchSnapshot();
  }, 60_000);

  const baseline = [{ file: 'scripts/legacy.mjs', kind: 'spawn', classification: 'resolved', fingerprint: JSON.stringify([['claude'], [], "'claude'", '[]']), count: 1 }];
  const dynamicBaseline = [{ ...baseline[0], classification: 'unresolved', fingerprint: JSON.stringify([[null], [null], 'command', 'argv']) }];
  it('accepts an exact call classification, fingerprint and count match despite line shifts', () => {
    assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': "spawn('claude', [])" }), baseline);
    assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': "\n\nspawn( 'claude', [] )" }), baseline);
  });
  it.each([
    ['resolved replacement', "spawn('claude', [])"],
    ['unresolved replacement', 'spawn(other, argv)'],
  ])('refuses an exempt unresolved call changed to a %s', (_name, source) => {
    expect(() => assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': source }), dynamicBaseline)).toThrow();
  });
  it('refuses changed command classification even when the command expression is unchanged', () => {
    const original = "const command = unknown; spawn(command, [])";
    const allowed = launchInventory(findAgentLaunches({ 'scripts/legacy.mjs': original }));
    expect(() => assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': "const command = 'claude'; spawn(command, [])" }), allowed)).toThrow();
  });
  it('refuses changed resolved command text while file, kind, classification and count stay fixed', () => {
    expect(() => assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': "spawn('codex', [])" }), baseline)).toThrow();
  });
  it('refuses changed wrapper argv even when the wrapper command is unchanged', () => {
    const allowed = launchInventory(findAgentLaunches({ 'scripts/legacy.mjs': "spawn('env', unknownArgs)" }));
    expect(() => assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': "spawn('env', ['claude'])" }), allowed)).toThrow();
  });
  it.each([
    ["const command = 'claude'; spawn(command, [])", "const command = 'codex'; spawn(command, [])"],
    ["const args = ['claude']; spawn('env', args)", "const args = ['codex']; spawn('env', args)"],
  ])('refuses changed resolved constants despite unchanged call expressions: %s', (before, after) => {
    const allowed = launchInventory(findAgentLaunches({ 'scripts/legacy.mjs': before }));
    expect(() => assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': after }), allowed)).toThrow();
  });
  it('classifies mutable member-derived command evidence as unresolved', () => {
    expect(findAgentLaunches({ 'scripts/mutated.mjs': "const config = {cmd: 'node'}; config.cmd = 'claude'; spawn(config.cmd, [])" }))
      .toMatchObject([{ classification: 'unresolved', reason: expect.stringContaining('unresolved command') }]);
  });
  it.each([
    ['new file', { 'skills-src/task/run.mjs': "spawn('claude', [])" }],
    ['new call kind', { 'scripts/legacy.mjs': "exec('claude -p hello')" }],
    ['increased call count', { 'scripts/legacy.mjs': "spawn('claude', []); spawn('codex', [])" }],
    ['removed allowlisted entry', {}],
    ['decreased call count', { 'scripts/legacy.mjs': "spawn('claude', [])" }, [{ ...baseline[0], count: 2 }]],
    ['unparseable source', { 'scripts/broken.mjs': "spawn('claude', [" }],
  ])('fails closed on %s', (_name, sources, allowed = baseline) => {
    expect(() => assertAllowlist(findAgentLaunches(sources), allowed)).toThrow();
  });

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
    destructuredAlias: "const { spawn: start } = cp; start('claude', [])",
    destructuredAliasChain: "const { spawn: start } = cp; const go = start; go('codex', [])",
    requiredPrimitive: "const { spawn } = require('node:child_process'); spawn('claude', [])",
    requiredAlias: "const { spawn: start } = require('node:child_process'); start('claude', [])",
    importedPrimitive: "const { spawn } = await import('node:child_process'); spawn('codex', [])",
    importedDestructuredAlias: "const { execFile: start } = await import('node:child_process'); start('codex', [])",
    nestedDestructuredAlias: "const { child: { spawn: start } } = { child: cp }; start('claude', [])",
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
  it.each([
    "const start = spawn.bind(null); start('claude', [])",
    "const start = cp.execFile.bind(null); start('codex', [])",
    "const start = exec.bind(null); start('claude -p hi')",
    "const start = spawn.call; start(null, 'claude', [])",
    "const start = execFile.apply; start(null, ['codex', []])",
    "const start = spawn['bind'](null); const next = start; next('claude', [])",
    "spawn.call(null, 'claude', [])",
    "execFile.apply(null, ['codex', []])",
    "const start = spawn.bind(null); start(command, argv)",
  ])('detects method-derived execution primitives (%s)', source => {
    const findings = findAgentLaunches({ 'scripts/derived.mjs': source });
    expect(findings.some(f => /^(?:start|next|spawn.call|execFile.apply)$/.test(f.kind))).toBe(true);
  });
  it('R37.10 refuses computed logging methods without proof of an unrelated callee', () => {
    expect(findAgentLaunches({ 'scripts/log.mjs': 'originals[m].call(target, msg)' }))
      .toMatchObject([{ reason: expect.stringContaining('opaque callee') }]);
  });
  it('fails closed when a source cannot be parsed', () => {
    expect(findAgentLaunches({ 'scripts/broken.mjs': "spawn('claude', [" })).toMatchObject([{ reason: expect.stringContaining('unparseable') }]);
  });
  it.each([
    ['reassigned command', "let cmd = 'node'; cmd = 'claude'; spawn(cmd, [])"],
    ['uninitialized command', "let cmd; cmd = 'codex'; spawn(cmd, [])"],
    ['function parameter', "function f(cmd) { spawn(cmd, []) } f('claude')"],
    ['parameter with safe default', "function f(cmd = 'node') { spawn(cmd, []) } f('claude')"],
    ['unknown constant', "const cmd = process.env.AGENT; cp.execFile(cmd, [])"],
    ['partially resolved conditional', "const cmd = flag ? 'node' : process.env.AGENT; spawn(cmd, [])"],
    ['dynamic template', 'exec(`echo safe; ${process.env.AGENT}`)'],
    ['unresolved shell script', "spawn('sh', ['-c', script])"],
    ['destructured dynamic command', "const { cmd } = config; spawn(cmd, [])"],
    ['reassigned destructured command', "let { cmd } = { cmd: 'node' }; cmd = 'codex'; spawn(cmd, [])"],
    ['destructured parameter with safe default', "function f({cmd = 'node'}) { spawn(cmd, []) }"],
    ['dynamic destructured primitive', "const { spawn: start } = cp; start(cmd, [])"],
    ['reassigned regexp receiver', "let runner = /agent/; runner = cp; runner.exec(cmd)"],
    ['mutated const object property', "const config = {cmd: 'node'}; config.cmd = 'claude'; spawn(config.cmd, [])"],
    ['computed mutated object property', "const config = {cmd: 'node'}; config['cmd'] = 'codex'; spawn(config['cmd'], [])"],
    ['aliased member command', "const config = {cmd: 'node'}; config.cmd = 'claude'; const cmd = config.cmd; spawn(cmd, [])"],
    ['destructured mutated object', "const config = {cmd: 'node'}; config.cmd = 'claude'; const {cmd} = config; spawn(cmd, [])"],
    ['object passed as command', "const config = {cmd: 'node'}; config.cmd = 'claude'; spawn(config, [])"],
    ['member command without mutation proof', "const config = {cmd: 'node'}; spawn(config.cmd, [])"],
  ])('fails closed on %s', (_name, source) => {
    expect(findAgentLaunches({ 'scripts/dynamic.mjs': source }).some(f => f.kind)).toBe(true);
  });
  it.each([
    ['ESM alias', "import * as cp from 'node:child_process'; cp[process.env.METHOD]('claude', [])"],
    ['default alias', "import cp from 'child_process'; cp[method]('codex', [])"],
    ['require alias', "const cp = require('child_process'); cp[process.env.METHOD](command, [])"],
    ['alias chain', "import * as cp from 'child_process'; const runner = cp; runner[method]('claude', [])"],
    ['unknown argv', "import * as cp from 'child_process'; cp[method]('node', argv)"],
    ['agent in argv', "import * as cp from 'child_process'; cp[method]('env', ['claude'])"],
  ])('flags unresolved computed primitive names on a %s', (_name, source) => {
    expect(findAgentLaunches({ 'scripts/computed.mjs': source }).filter(f => /\]$/.test(f.kind))).toHaveLength(1);
  });
  it.each(['env', 'nohup', 'command', 'exec', 'xargs', 'sudo', 'time', 'nice', 'setsid', 'stdbuf', 'arch', 'caffeinate', 'sh', 'bash', 'zsh', 'node'])
  ('flags %s wrappers with agent tokens, script text or unresolved arguments', command => {
    for (const argv of ["['claude', '-p', 'hello']", "['/tools/codex', 'exec']", "['-c', 'claude -p hello']",
      "['-e', `require('child_process').spawn('codex', [])`]", 'unknownArgs']) {
      expect(findAgentLaunches({ 'scripts/wrapper.mjs': `spawn('/usr/bin/${command}', ${argv})` })).toHaveLength(1);
    }
  });
  it.each(["spawn('env', ['node', 'script.mjs'])", "spawn('node', ['-e', 'console.log(1)'])", "spawn('nohup', ['claude-tools'])",
    "import * as cp from 'child_process'; cp['spawn']('git', [])"])
  ('permits wrapper and computed calls proven unrelated: %s', source => {
    expect(findAgentLaunches({ 'scripts/safe-wrapper.mjs': source })).toEqual([]);
  });
  it('retains the central launcher exemption for dynamic commands', () => {
    expect(findAgentLaunches({ 'scripts/lib/agent-launch.mjs': 'spawn(command, argv)' })).toEqual([]);
  });
  it('counts dynamic calls against the exact migration allowlist', () => {
    assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': 'spawn(command, argv)' }), dynamicBaseline);
    expect(() => assertAllowlist(findAgentLaunches({ 'scripts/legacy.mjs': 'spawn(command, argv); spawn(other, [])' }), dynamicBaseline)).toThrow();
  });
  it.each([
    "spawn('node', [])",
    "const cmd = 'git'; cp.execFile(cmd, [])",
    "const cmd = flag ? 'node' : 'git'; spawn(cmd, [])",
    "cp.spawn('node', [])",
    "const { cmd } = { cmd: 'git' }; spawn(cmd, [])",
    "const { nested: { cmd } } = { nested: { cmd: 'git' } }; spawn(cmd, [])",
    "const pattern = /agent/; pattern.exec(input); /claude/.exec(input); new RegExp('agent').exec(input)",
  ])('permits a command proven to be unrelated (%s)', source => {
    expect(findAgentLaunches({ 'scripts/safe.mjs': source })).toEqual([]);
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
