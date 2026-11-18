import { describe, expect, it } from 'vitest';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { findAgentLaunches } from './fixtures/agent-launch-source.mjs';
import { AGENT_LAUNCH_ALLOWLIST, findAgentLaunches as scanAgentLaunches, readAgentLaunchTree } from '../lib/agent-launch-structure.mjs';


// Capability boundary, paired with the runtime assertion in agent-launch.mjs.
const root = resolve(import.meta.dirname, '../..');
// Production migration evidence pins each approved file's whole-module fingerprint.
// Membership is separate: a snapshot update cannot approve another capability-bearing file.
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
  // Parse failures have no inventory kind and must never be exempted.
  expect(findings.filter(f => !f.kind), 'scanner must establish complete module evidence').toEqual([]);
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
  expect(inventory, 'approved module changed: complete source review required').toEqual(allowlist);
}

describe('single agent launch boundary', () => {
  it.each([
    ...['child_process', 'worker_threads', 'cluster', 'vm', 'inspector', 'inspector/promises',
      'repl', 'module', 'v8', 'wasi', 'process'].flatMap(name => [name, `node:${name}`])
      .flatMap(module => ['import', 'export', 'require', 'dynamic import'].map(form => ({
        name: `R37.20 execution builtin ${module} via ${form}`, bare: true, refused: true,
        builtin: module,
        source: form === 'import' ? `import * as api from '${module}';`
          : form === 'export' ? `export * from '${module}';`
            : form === 'require' ? `const api=require('${module}');` : `import('${module}');`,
      }))),
    { name: 'R37.20 benign builtin positive control', bare: true,
      source: "import {basename} from 'node:path'; basename('git')" },
    ...[
      `(async()=>{})['con'+'structor']("return (await import('node:child_process')).spawn('claude',[])")()`,
      'const run=(async()=>{})[key];', 'const run=target[key];', 'const run=target?.[key];',
      'const run=target[0+0];', 'const run=target[("safe")];', 'const run=target[`con${suffix}`];',
      'const run=target.constructor;', 'const run=target["constructor"];',
      'const run=target["__proto__"];', 'const run=target["prototype"];',
      'const run=Reflect.get(target,key);', 'const run=Object.getPrototypeOf(target).constructor;',
      'const run=Function;', 'const run=AsyncFunction;', 'const run=GeneratorFunction;',
      'const run=AsyncGeneratorFunction;', 'import(specifier);', 'require(specifier);',
      "const key='a'; const data={a:'hello'}; console.log(data[key])",
    ].map(source => ({ name: `R37.21 capability access fails closed: ${source}`, source, bare: true, refused: true })),
    ...['"safe"', '0', '`safe`'].map(key => ({ name: `R37.21 literal member positive control: ${key}`,
      source: `const data={safe:'ok',0:'ok'}; console.log(data[${key}]);`, bare: true })),
    { name: 'R37.17 existing exported helper cannot bypass the caller boundary',
      source: "spawnToCompletion('claude', ['--resume','unchecked-id'])", bare: true, refused: true },
    ...["spawn('npx', ['claude'])", "spawn('pnpm', ['exec', 'codex'])",
      "spawn('custom-wrapper', ['claude'])", "spawn('echo x; claude', [], {shell:true})",
      "exec('echo x; claude')", "execSync('echo x; codex')",
      "spawn('custom', ['echo x; codex'], {shell:true})"].map(source => ({ name: `R37.6 literal agent word: ${source}`, source, refused: true })),
    { name: 'R37.6 unrelated literal wrapper now requires boundary', source: "spawn('npx', ['unrelated-tool'])", refused: true },
    { name: 'R37.6 agent name substring now requires boundary', source: "spawn('custom', ['claude-tools', 'mycodex'], {shell:true})", refused: true },
    ...["clau'de'", 'co"dex"', 'clau\\de', 'cla*de', 'co?ex', 'cla[up]de', 'co{d,d}ex',
      '$tool', '${tool}', '$(printf tool)', '`printf tool`'].flatMap(command => {
      const script = JSON.stringify(`${command} --resume unchecked-id`);
      return [
        `spawn('sh', ['-c', ${script}])`,
        `exec(${script})`,
        `execSync(${script})`,
        `import {exec as execute} from 'node:child_process'; execute(${script})`,
        `cp.exec(${script})`,
        `spawn(${script}, [], {shell:true})`,
      ].map(source => ({ name: `R37.12 shell text: ${source}`, source, refused: true }));
    }),
    { name: 'R37.12 wholly quoted agent command', source: 'spawn("sh", ["-c", "\\"claude\\" --resume unchecked-id"])', refused: true },
    { name: 'R37.12 literal unrelated shell command now requires boundary', source: "spawn('sh', ['-c', 'git status --short'])", refused: true },
    { name: 'R37.12 wholly quoted unrelated shell command now requires boundary', source: 'exec("\\"git\\" status")', refused: true },
    { name: 'R37.12 shell syntax in direct argv now requires boundary', source: 'spawn("git", ["$tool", "*", "{a,b}", "clau\\\'de\\\'"])', refused: true },
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
    { name: 'R37.7 non-primitive conditional with agent argument now refuses', source: "const f=flag ? console.log : console.info; f('claude',[])", refused: true },
    ...[
      "function factory(){return spawn} const start=factory(); start('claude',[])",
      "function factory(){return spawn} factory()('claude',[])",
      "function factory(){return () => spawn} const start=factory()(); start('git',[])",
      "function invoke(start){start('git',[])} invoke(spawn)",
      "function factory(){return spawn}",
      "function store(){ const saved=spawn; }",
      "function store(){ const {spawn:start}=cp; }",
      "function pass(){ accept(spawn); }",
      "export const start=spawn",
      "export {spawn as start} from 'node:child_process'",
      "function invoke(){ const saved={start:spawn}; return saved; }",
      "const registry={}; registry.start=spawn; registry.start('git',[])",
      "import cp from 'node:child_process'; const other=cp; other.spawn=opaque; cp.spawn('git',[])",
      "const start=flag?spawn:console.log; function factory(){return start}",
      "(flag ? spawn : opaque())('git',[])",
      "function invoke(start=spawn){start('git',[])}",
      "const start=spawn; export function factory(){return start}",
    ].map(source => ({ name: `R37.10 opaque callee or primitive escape: ${source}`, source, refused: true })),
    { name: 'R37.10 factory and returned callee each require review even for git',
      source: "function factory(){return spawn} const start=factory(); start('git',[])",
      refused: true },
    { name: 'R37.10 passed parameter callee requires review even for git',
      source: "function invoke(start){start('git',[])} invoke(spawn)",
      refused: true },
    { name: 'R37.10 passing a reference is itself a finding',
      source: "function pass(){console.log(spawn)}", refused: true },
    { name: 'R37.10 unbound primitive-name callee', source: "spawn('git',[])", bare: true, refused: true },
    { name: 'R37.10 unbound namespace-name callee', source: "cp.spawn('git',[])", bare: true, refused: true },
    { name: 'R37.10 local function with agent argument now refuses', source: "function start(){return 'ok'} start('claude',[])", refused: true },
    { name: 'R37.10 local closure with agent argument now refuses', source: "const start=() => console.log('ok'); start('claude',[])", refused: true },
    { name: 'R37.15 unknown imported primitive-name callee requires review', source: "import {spawn} from 'unrelated'; spawn('claude',[])", refused: true },
    { name: 'R37.7 imported non-primitive with agent argument now refuses', source: "import {log as start} from 'node:console'; start('claude',[])", refused: true },
    ...['execa', 'cross-spawn', 'shelljs', 'zx', 'node-pty', 'tinyexec', 'nano-spawn',
      'foreground-child', '@npmcli/promise-spawn', 'execa/subpath'].map(module => ({
      name: `R37.15 process-exec module ${module} is never presumed benign`,
      source: `import launch from '${module}'; launch('git',[])`, refused: true,
    })),
    ...['node:worker_threads', 'worker_threads', 'node:cluster', 'cluster', 'node:vm', 'vm',
      'node:process', 'process'].map(module => ({
      name: `R37.15 execution builtin ${module} cannot clear agent arguments`,
      source: `import launch from '${module}'; launch('claude',[])`, refused: true,
    })),
    ...[
      "import {execa} from 'execa'; execa('codex',['exec','resume','unchecked-id'])",
      "import launch from './uninspected-launcher.mjs'; launch('claude',[])",
      "import {launch} from 'unknown-package'; launch('git',['claude'])",
      "import * as tools from 'unknown-package'; tools.launch('git',['codex'])",
      "import tools from 'unknown-package'; tools['launch']('git',['codex'])",
      "import launch from 'unknown-package'; const run=launch; const binary='codex'; run(binary,[])",
      "import launch from 'unknown-package'; const argv=['claude']; launch('git',argv)",
      "import launch from 'unknown-package'; launch({command:'claude'})",
      "import launch from 'unknown-package'; const options={command:'codex'}; launch(options)",
      "import launch from 'unknown-package'; launch('clau'+'de',[])",
      `import launch from 'unknown-package'; launch('git',[${JSON.stringify("clau'de'")}])`,
      `import launch from 'unknown-package'; launch(${JSON.stringify('co\\dex')},[])`,
      "import launch from 'unknown-package'; launch('git'); launch('claude')",
    ].map(source => ({ name: `R37.15 imported agent argument: ${source}`, source, refused: true })),
    { name: 'R37.15 benign builtin with agent argument now refuses', source: "import {basename} from 'node:path'; basename('claude')", refused: true },
    { name: 'R37.15 unknown package without agent arguments now requires boundary', source: "import launch from 'unknown-package'; launch('git',[])", refused: true },
    { name: 'R37.15 agent substring now requires boundary', source: "import launch from 'unknown-package'; launch('claude-tools',['mycodex'])", refused: true },
    ...[
      `const options={shell:true}; spawn(${JSON.stringify('clau\\de')},[],options)`,
      `const options={shell:true}; const alias=options; spawn(${JSON.stringify('clau\\de')},[],alias)`,
      `const options={shell:true}; spawn('git',[${JSON.stringify('co"dex"')}],options)`,
      `const options={shell:true}; spawn(${JSON.stringify('clau\\de')},options)`,
      `spawn(${JSON.stringify('clau\\de')},[],options)`,
      `spawn('git',[${JSON.stringify("clau'de'")}],options)`,
      `const options=buildOptions(); spawn(${JSON.stringify('clau\\de')},[],options)`,
      `let options={shell:false}; spawn(${JSON.stringify('clau\\de')},[],options)`,
      `const options={shell:false}; options.shell=true; spawn(${JSON.stringify('clau\\de')},[],options)`,
      `const options={shell:false,...other}; spawn(${JSON.stringify('clau\\de')},[],options)`,
      `const options={shell:false,[key]:true}; spawn(${JSON.stringify('clau\\de')},[],options)`,
    ].map(source => ({ name: `R37.16 bound or unknown shell options: ${source}`, source, refused: true })),
    { name: 'R37.16 bound shell:false keeps escaped executable literal now requires boundary',
      source: `const options={shell:false}; spawn(${JSON.stringify('clau\\de')},[],options)`, refused: true },
    { name: 'R37.16 bound shell:false keeps argv shell syntax literal now requires boundary',
      source: `const options={shell:false}; spawn('git',[${JSON.stringify("clau'de'")}],options)`, refused: true },
    { name: 'R37.16 known empty options now requires boundary', source: "const options={}; spawn('git',['$tool'],options)", refused: true },
    { name: 'R37.16 literal unrelated shell command now requires boundary', source: "const options={shell:true}; spawn('git',['status'],options)", refused: true },
  ])('$name', ({ source, refused, bare, builtin }) => {
    const findings = (bare ? scanAgentLaunches : findAgentLaunches)({ 'scripts/r37-structure.mjs': source });
    if (refused) {
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].reason).toContain('outside approved boundary');
      if (builtin) expect(findings[0].reason).toContain(`execution builtin: ${builtin}`);
    } else expect(findings).toEqual([]);
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


  const approvedFile = 'scripts/lib/agent-launch.mjs';
  const inventoryFor = source => launchInventory(scanAgentLaunches({ [approvedFile]: source }));
  const helperFile = 'scripts/lib/spawn-to-completion.mjs';
  const helperSource = readFileSync(resolve(root, helperFile), 'utf8');
  it.each([
    ["export function run(target,key){return target[key]}", 'computed access'],
    ["export function run(){return (async()=>{})['con'+'structor']}", 'computed constructor'],
    ["export function run(specifier){return import(specifier)}", 'dynamic import'],
    ["export function run(specifier){return require(specifier)}", 'dynamic require'],
    ["export {Session as run} from 'node:inspector'", 'inspector re-export'],
  ])('R37.20–21 propagates %s to imported bindings (%s)', (implementation) => {
    const findings = scanAgentLaunches({ 'scripts/local.mjs': implementation,
      'scripts/consumer.mjs': "import {run} from './local.mjs'; const alias=run; accept(alias)" });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs'))?.reason).toContain('launcher export reference');
  });
  it('R37.21 literal-key export positive control stays clear through aliases', () => {
    expect(scanAgentLaunches({ 'scripts/local.mjs': "export function read(target){return target['safe']}",
      'scripts/consumer.mjs': "import {read} from './local.mjs'; const alias=read; accept(alias)" })).toEqual([]);
  });
  it('R37.17 flags a new caller of the existing spawnToCompletion export without changing approved fingerprints', () => {
    const sources = { [helperFile]: helperSource };
    const before = scanAgentLaunches(sources);
    const after = scanAgentLaunches({ ...sources,
      'scripts/new-consumer.mjs': "import {spawnToCompletion} from './lib/spawn-to-completion.mjs'; spawnToCompletion('claude', ['--resume','unchecked-id'])" });
    expect(after.find(f => f.file.endsWith('/new-consumer.mjs')).reason).toContain('launcher export reference: spawnToCompletion');
    expect(after.filter(f => !f.file.endsWith('/new-consumer.mjs'))).toEqual(before);
  });
  it('R37.17 approved existing completion-wrapper caller passes its unchanged inventory', () => {
    const sources = { [helperFile]: helperSource, [approvedFile]: readFileSync(resolve(root, approvedFile), 'utf8') };
    const findings = scanAgentLaunches(sources);
    expect(findings).toHaveLength(2);
    expect(findings.every(f => f.reason === 'approved boundary inventory; exact module fingerprint required')).toBe(true);
    assertAllowlist(findings, launchInventory(scanAgentLaunches(sources)));
  });
  it.each([
    ['renamed import', "import {run as execute} from './bridge.mjs'; execute('git', [])"],
    ['reference without invocation', "import {run} from './bridge.mjs'; const saved=run"],
    ['namespace reference', "import * as bridge from './bridge.mjs'; accept(bridge)"],
    ['namespace member', "import * as bridge from './bridge.mjs'; bridge.run('git', [])"],
    ['computed namespace member', "import * as bridge from './bridge.mjs'; bridge['run']('git', [])"],
    ['dynamic namespace member', "import * as bridge from './bridge.mjs'; bridge[key]('git', [])"],
    ['default import', "import execute from './bridge.mjs'; execute('git', [])"],
    ['required namespace', "const bridge=require('./bridge.mjs'); bridge.run('git', [])"],
    ['dynamic import', "const bridge=await import('./bridge.mjs'); bridge.run('git', [])"],
  ])('traces transitive wrappers and re-exports to the caller: %s', (_name, consumer) => {
    const findings = scanAgentLaunches({
      [helperFile]: helperSource,
      'scripts/wrapper.mjs': "import {spawnToCompletion as complete} from './lib/spawn-to-completion.mjs'; const relay=(...args)=>complete(...args); export function execute(...args){return relay(...args)}",
      'scripts/bridge.mjs': "export {execute as run, execute as default} from './wrapper.mjs'",
      'scripts/consumer.mjs': consumer,
    });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs')).reason).toContain('launcher export reference');
  });
  it.each([
    "import {spawn as primitive} from 'node:child_process'; export default (...args)=>primitive(...args)",
    "import {spawn as primitive} from 'node:child_process'; export default function(...args){return primitive(...args)}",
    "import {spawn as primitive} from 'node:child_process'; let chosen; chosen=primitive; export function run(...args){return chosen(...args)}; export default run",
    "import {spawn as primitive} from 'node:child_process'; let chosen; ({launch:chosen}={launch:primitive}); export default (...args)=>chosen(...args)",
    "import {spawn as primitive} from 'node:child_process'; const choices=[]; choices.push(primitive); export default (...args)=>choices[0](...args)",
    "import * as primitives from 'node:child_process'; const {spawn:run}=primitives; export default (...args)=>run(...args)",
    "import {spawn as primitive} from 'node:child_process'; const run=(...args)=>primitive(...args); export default {run}",
    "import {spawn as primitive} from 'node:child_process'; export default {run(...args){return primitive(...args)}}",
    "import {spawn as primitive} from 'node:child_process'; export default class {run(...args){return primitive(...args)}}",
    "import {spawn as primitive} from 'node:child_process'; module.exports=(...args)=>primitive(...args)",
  ])('traces exported definitions, assignments and containers: %s', source => {
    const findings = scanAgentLaunches({ 'scripts/local.mjs': source,
      'scripts/consumer.mjs': "import run from './local.mjs'; accept(run)" });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs')).reason).toContain('launcher export reference');
  });
  it.each([
    "opaque('claude', ['--resume','unchecked-id'])",
    "opaque(['git', ['codex', 'exec', 'resume', 'unchecked-id']])",
    'opaque(`claude --resume ${id}`)',
    'opaque(`env ${prefix} codex exec resume unchecked-id`)',
    `opaque(${JSON.stringify("clau'de' --resume unchecked-id")})`,
    `opaque(${JSON.stringify('co\\dex exec resume unchecked-id')})`,
    "console.log({command:'claude'})",
    "function launchAgent(){}; launchAgent('claude', [])",
    "import {basename} from 'node:path'; basename('claude')",
  ])('R37.18 refuses agent-word literal arguments regardless of callee provenance: %s', source => {
    expect(scanAgentLaunches({ 'scripts/consumer.mjs': source }))
      .toMatchObject([{ reason: expect.stringContaining('agent-word argument outside launchAgent') }]);
  });
  it.each([
    "import {launchAgent as run} from './lib/agent-launch.mjs'; run({}, null, 'claude', [])",
    "import * as boundary from './lib/agent-launch.mjs'; boundary.launchAgent({}, null, 'codex', [])",
    "import {run} from './bridge.mjs'; run({}, null, 'claude', [])",
  ])('exempts the actual launchAgent export through aliases and re-exports: %s', source => {
    const findings = scanAgentLaunches({
      [approvedFile]: "import {spawn} from 'node:child_process'; export function launchAgent(...args){return spawn(...args)}",
      'scripts/bridge.mjs': "export {launchAgent as run} from './lib/agent-launch.mjs'",
      'scripts/consumer.mjs': source,
    });
    expect(findings.filter(f => !f.file.endsWith('/lib/agent-launch.mjs'))).toEqual([]);
  });
  it('does not exempt an exported wrapper of launchAgent', () => {
    const findings = scanAgentLaunches({
      [approvedFile]: "import {spawn} from 'node:child_process'; export function launchAgent(...args){return spawn(...args)}",
      'scripts/wrapper.mjs': "import {launchAgent} from './lib/agent-launch.mjs'; export function run(...args){return launchAgent(...args)}",
      'scripts/consumer.mjs': "import {run} from './wrapper.mjs'; run('git',[])" });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs')).reason).toContain('launcher export reference');
  });
  it('fails closed on a missing export of an inspected local module', () => {
    const findings = scanAgentLaunches({ 'scripts/local.mjs': 'export const text="hello"',
      'scripts/consumer.mjs': "import {missing} from './local.mjs'; missing('git',[])" });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs')).reason).toContain('launcher export reference');
  });
  it('fails closed for an opaque star re-export referenced as a namespace', () => {
    const findings = scanAgentLaunches({ 'scripts/local.mjs': "export * from 'future-exec-package'",
      'scripts/consumer.mjs': "import * as local from './local.mjs'; accept(local)" });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs')).reason).toContain('launcher export reference');
  });
  it('does not treat computed property keys or process data reads as execution bindings', () => {
    const findings = scanAgentLaunches({
      'scripts/local.mjs': "import {spawn} from 'node:child_process'; export const KEY='hello'; const bag={}; bag[KEY]=spawn; process.env.FLAG='yes'",
      'scripts/consumer.mjs': "import {KEY} from './local.mjs'; export function pure(env=process.env){ return KEY+env.FLAG }" });
    expect(findings.filter(f => f.file.endsWith('/consumer.mjs'))).toEqual([]);
  });
  it('keeps capability-free local exports and benign builtin re-exports clear', () => {
    expect(scanAgentLaunches({ 'scripts/local.mjs': "export {log as output} from 'node:console'; export function pure(){return 'ok'}",
      'scripts/consumer.mjs': "import {output, pure} from './local.mjs'; output(pure())" })).toEqual([]);
  });
  it('resolves pure CommonJS named re-exports without treating them as missing evidence', () => {
    expect(scanAgentLaunches({ 'scripts/local.cjs': "function pure(){return 'ok'}; module.exports={pure}",
      'scripts/bridge.mjs': "export {pure} from './local.cjs'",
      'scripts/consumer.mjs': "import {pure} from './bridge.mjs'; pure('git')" })).toEqual([]);
  });
  it('traces CommonJS named launcher re-exports to the consumer', () => {
    const findings = scanAgentLaunches({ 'scripts/local.cjs': "const {spawn:run}=require('node:child_process'); module.exports={run}",
      'scripts/bridge.mjs': "export {run} from './local.cjs'",
      'scripts/consumer.mjs': "import {run} from './bridge.mjs'; run('git')" });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs')).reason).toContain('launcher export reference');
  });
  const probes = [
    { name: 'R37 argv element mutation',
      before: "import {spawn} from 'node:child_process'; function launch(){const argv=['git']; spawn('env',argv)}",
      after: "import {spawn} from 'node:child_process'; function launch(){const argv=['git']; argv[0]='claude'; spawn('env',argv)}" },
    { name: 'R37 shell option alias mutation with escaped clau\\de',
      before: String.raw`import {spawn} from 'node:child_process'; function launch(){const options={shell:false}; const alias=options; spawn('clau\\de',[],options)}`,
      after: String.raw`import {spawn} from 'node:child_process'; function launch(){const options={shell:false}; const alias=options; alias.shell=true; spawn('clau\\de',[],options)}` },
    { name: 'R37 unknown package with dynamic process.env.AGENT',
      before: "import launch from 'unknown-package'; function run(){launch('git',[])}",
      after: "import launch from 'unknown-package'; function run(){launch(process.env.AGENT,[])}" },
    { name: 'R37 Worker eval containing a child-process Claude launch',
      before: `import {Worker} from 'node:worker_threads'; function launch(){new Worker('./worker.mjs',{eval:false})}`,
      after: `import {Worker} from 'node:worker_threads'; function launch(){new Worker("require('child_process').spawn('claude',[])",{eval:true})}` },
  ];
  it.each(probes)('$name refuses outside the boundary regardless of argv', ({ before, after }) => {
    for (const source of [before, after]) {
      expect(scanAgentLaunches({ 'scripts/unapproved.mjs': source }))
        .toMatchObject([{ kind: 'module', reason: expect.stringContaining('outside approved boundary') }]);
    }
  });
  it.each(probes)('$name invalidates the approved whole-module fingerprint', ({ before, after }) => {
    const baseline = inventoryFor(before);
    expect(baseline).toHaveLength(1);
    expect(baseline[0].fingerprint).toMatch(/^module-sha256-v2:[a-f0-9]{64}$/);
    expect(() => assertAllowlist(scanAgentLaunches({ [approvedFile]: after }), baseline)).toThrow();
  });
  it.each(probes)('$name unchanged approved file positive control', ({ before }) => {
    assertAllowlist(scanAgentLaunches({ [approvedFile]: before }), inventoryFor(before));
  });

  it.each([
    ...['child_process', 'node:child_process', 'worker_threads', 'node:worker_threads', 'vm', 'node:vm',
      'cluster', 'node:cluster', 'process', 'node:process', 'module', 'node:module',
      'execa', 'cross-spawn', 'shelljs', 'zx', 'node-pty', 'tinyexec', 'nano-spawn',
      'foreground-child', '@npmcli/promise-spawn', 'future-exec-package', 'execa/subpath']
      .flatMap(module => [`import * as capability from '${module}';`,
        `export * from '${module}';`, `const capability=require('${module}');`, `import('${module}');`]),
    "process.binding('spawn_sync')", "process['binding']('spawn_sync')", 'const alias=process; alias.dlopen(m,path)',
    'const {binding:alias}=process', 'process.dlopen(m,path)', 'const load=require; load(name)',
    'import(name)', 'require(name)', 'require(`node:${name}`)', "require('node:'+'child_process')",
    'eval(code)', 'const execute=eval', 'new Function(code)', 'const Construct=Function; new Construct(code)',
    'new Worker(code,{eval:true})', 'const Construct=Worker; new Construct(code,{eval:true})',
    'const evaluate=globalThis.eval; evaluate(code)', 'globalThis[name](code)', "(() => {}).constructor(code)()",
    "(() => {})['constructor'](code)()", 'const get=Reflect.get; get(target,key)',
    'import capability = require("child_process")',
  ])('refuses the capability reference even without a launch: %s', source => {
    expect(scanAgentLaunches({ 'scripts/unapproved.ts': source }).length).toBeGreaterThan(0);
  });

  it.each([
    "import {basename} from 'node:path'; basename('git')",
    "const {basename}=require('node:path'); basename('git')",
    "import('node:path')", "export {basename} from 'node:path'",
    "const env=process.env; const pid=process.pid; module.exports={env,pid}",
    "const data={a:'hello'}; console.log(data['a'])",
    "function launch(){return 'claude'} launch()",
    "const launch=console.log; launch('git')",
    "const pattern=/claude/; pattern.exec('hello')",
    "const start = opaque(); start('git',[])",
    "function relay(start){ return () => start('git',[]) }",
    "function invoke(start=console.log){start('git',[])}",
    "function pure(){return 'ok'} const start=opaque(pure); start('git',[])",
    "// spawn('claude')\nconst help=\"require('child_process')\"",
  ])('keeps source without a capability clear: %s', source => {
    expect(scanAgentLaunches({ 'scripts/benign.mjs': source })).toEqual([]);
  });

  it.each([
    ['local function', "export function launch(){return 'ok'}", false],
    ['benign re-export', "export {log as launch} from 'node:console'", false],
    ['missing re-export', "export {launch} from './missing.mjs'", true, true],
    ['execution re-export', "export {execa as launch} from 'execa'", true, true],
    ['returned primitive', "import {spawn} from 'child_process'; export function launch(){return spawn}", true, true],
    ['default primitive object', "import {spawn} from 'child_process'; export default {start:spawn}", true, true],
    // Capability-free exports stay clear even alongside an unrelated execution import.
    ['importing a flagged module from an unflagged one is not itself a finding', "import 'child_process'; export const text='hello'", true],
    ['malformed source', 'export const launch = (', true, true],
  ])('traces %s exports to a namespace reference', (_name, implementation, refused, consumerRefused = false) => {
    const findings = scanAgentLaunches({
      'scripts/local.mjs': implementation,
      'scripts/consumer.mjs': "import * as local from './local.mjs'; console.log(local)",
    });
    expect(findings.some(f => f.file.endsWith('/local.mjs'))).toBe(refused);
    expect(findings.some(f => f.file.endsWith('/consumer.mjs'))).toBe(consumerRefused);
  });
  it('propagates launcher references through cyclic imports and renamed re-exports', () => {
    const findings = scanAgentLaunches({
      'scripts/a.mjs': "export * from './b.mjs'; export * from './c.mjs'",
      'scripts/b.mjs': "export * from './a.mjs'",
      'scripts/c.mjs': "export {spawn as launch} from 'node:child_process'",
      'scripts/consumer.mjs': "import {launch as run} from './b.mjs'; run('git',[])",
    });
    expect(findings.map(f => f.file)).toEqual(['a', 'b', 'c', 'consumer'].map(n => resolve(`scripts/${n}.mjs`)));
  });
  it('referencing a launcher in an approved module still flags its unapproved caller', () => {
    const findings = scanAgentLaunches({ [approvedFile]: "import {spawn as launch} from 'child_process'; export {launch}",
      'scripts/consumer.mjs': "import {launch as run} from './lib/agent-launch.mjs'; run('git',[])" });
    expect(findings.map(f => f.file)).toEqual([resolve(approvedFile), resolve('scripts/consumer.mjs')]);
  });
  it('a direct capability binding still flags the importer of an approved module', () => {
    const findings = scanAgentLaunches({ [approvedFile]: "import {spawn} from 'child_process'; export {spawn}",
      'scripts/consumer.mjs': "import {spawn as launch} from './lib/agent-launch.mjs'; launch('git',[])" });
    expect(findings.find(f => f.file.endsWith('/consumer.mjs')).reason).toContain('outside approved boundary');
  });
  it('fails closed for missing local source and an unknown package even with git arguments', () => {
    for (const specifier of ['./missing.mjs', 'unknown-package']) {
      expect(scanAgentLaunches({ 'scripts/unapproved.mjs': `import launch from '${specifier}'; launch('git',[])` }))
        .toMatchObject([{ reason: expect.stringContaining('uninspected') }]);
    }
  });
  it('fails closed on malformed source even on the approved boundary', () => {
    for (const file of [approvedFile, 'scripts/unapproved.mjs']) {
      expect(scanAgentLaunches({ [file]: "spawn('claude',[" }))
        .toMatchObject([{ reason: expect.stringContaining('unparseable') }]);
      expect(scanAgentLaunches({ [file]: "spawn('claude',[" })[0].kind).toBeUndefined();
    }
  });
  it('fails closed when the production source tree is unreadable or incomplete', () => {
    expect(() => readAgentLaunchTree(resolve(root, 'scripts/__tests__/missing-source-root'))).toThrow();
  });

  it.each([
    ["const value='git'; function launch(){spawn(value,[])}", "const value='claude'; function launch(){spawn(value,[])}"],
    ["function launch(){spawn(command,argv)} launch('git',[])", "function launch(){spawn(command,argv)} launch('claude',[])"],
    ["let unrelated='git'; spawn(command,argv)", "let unrelated='claude'; spawn(command,argv)"],
    ["const launch=() => {spawn(command,argv)}", "const launch=() => {audit(); spawn(command,argv)}"],
    ["class Runner {launch(){spawn(command,argv)}}", "class Runner {launch(){argv[0]='claude'; spawn(command,argv)}}"],
    ["const runner={launch(){spawn(command,argv)}}", "const runner={launch(){options.shell=true; spawn(command,argv)}}"],
    ["function launch(){return () => spawn(command,argv)}", "function launch(){return () => {options.shell=true; return spawn(command,argv)}}"],
    ["spawn(command,argv)", "spawn(command,argv); spawn(command,argv)"],
    ["spawn(command,argv)", "exec(command)"],
    ["spawn(command,argv)", "spawn(command,argv);"],
    ["spawn(command,argv)", ""],
  ])('pins every module edit, including surrounding definitions: %s', (before, after) => {
    expect(inventoryFor(before)).not.toEqual(inventoryFor(after));
  });
  it('normalises whitespace and comments while keeping unchanged approved code valid', () => {
    const before = "import {spawn} from 'child_process'; function launch(){const argv=['git']; spawn('env',argv)}";
    const after = "\n// comment\nimport { spawn } from 'child_process';\n\nfunction launch( ) {\n /* comment */ const argv = [ 'git' ];\n spawn( 'env', argv )\n}\n";
    expect(inventoryFor(after)).toEqual(inventoryFor(before));
  });
  it.each([
    ["const text='a b'; spawn(text,[])", "const text='ab'; spawn(text,[])"],
    ["const text='a/*b*/'; spawn(text,[])", "const text='a'; spawn(text,[])"],
    ['const text=`a b`; spawn(text,[])', 'const text=`ab`; spawn(text,[])'],
    ['const text=/a b/; spawn(text,[])', 'const text=/ab/; spawn(text,[])'],
    ['function launch(){return\nspawn(command,argv)}', 'function launch(){return spawn(command,argv)}'],
  ])('normalisation preserves literal contents and ASI semantics: %s', (before, after) => {
    expect(inventoryFor(before)).not.toEqual(inventoryFor(after));
  });
  it('membership cannot be expanded by recording an unapproved capability fingerprint', () => {
    const findings = scanAgentLaunches({ 'scripts/new-launcher.mjs': "import {spawn} from 'child_process'" });
    expect(findings).toHaveLength(1);
    expect(AGENT_LAUNCH_ALLOWLIST).not.toContain('scripts/new-launcher.mjs');
    expect(findings[0].reason).toContain('outside approved boundary');
  });
  it('pins the original migration membership independently of fingerprints', () => {
    const reviewedExistingCallers = [
      'scripts/conveyor/health-smells-notify-list.mjs',
      'scripts/conveyor/maintenance-marker.mjs',
      'scripts/lib/daemon-rebuild/index.mjs',
      'scripts/operations/reopen-items-io.mjs',
      'scripts/lib/raised-by.mjs',
      // R37.21: inspected existing data-key readers and classifier re-exports. Their complete
      // fingerprints remain required; computed access is never exempted by argument semantics.
      'scripts/lib/daemon-rebuild/smoke-classify/index.mjs',
      'scripts/lib/model-settings.mjs',
      'scripts/lib/node-heap-cap.mjs',
    ];
    expect(AGENT_LAUNCH_ALLOWLIST).toHaveLength(1857 + reviewedExistingCallers.length);
    expect(new Set(AGENT_LAUNCH_ALLOWLIST).size).toBe(AGENT_LAUNCH_ALLOWLIST.length);
    expect(createHash('sha256').update(JSON.stringify(AGENT_LAUNCH_ALLOWLIST.slice(0, 1857))).digest('hex'))
      .toBe('459d30e7bbc103ef4fe3ac70db57c2c4d964888c12ac17e581da8494b285dd06');
    expect(AGENT_LAUNCH_ALLOWLIST.slice(1857)).toEqual(reviewedExistingCallers);
  });
  it('permits exactly the unmigrated allowlist throughout scripts/ and skills-src/', () => {
    const findings = scanAgentLaunches(readAgentLaunchTree(root));
    expect.soft(findings.filter(f => !AGENT_LAUNCH_ALLOWLIST.includes(relative(root, f.file).replaceAll('\\', '/'))),
      'new capability file needs boundary review, never a snapshot-only approval').toEqual([]);
    const inventory = migrationEvidence(findings.filter(f => AGENT_LAUNCH_ALLOWLIST.includes(relative(root, f.file).replaceAll('\\', '/'))));
    expect(inventory.map(row => row.file).sort()).toEqual([...AGENT_LAUNCH_ALLOWLIST].sort());
    expect(inventory).toMatchSnapshot();
  }, 60_000);
});
