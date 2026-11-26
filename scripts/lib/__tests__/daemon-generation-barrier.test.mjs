import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { keepAliveScript } from '../test-keepalive.mjs';
import {
  awaitGroupDeath, decidePromotion, mayHandOver, settleDecision, scanNewSessionSpawns, MERGE_CAPABLE_SPAWN_ALLOWLIST,
} from '../daemon-generation-barrier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..'); // scripts/
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errCode = (code) => Object.assign(new Error(code), { code });

// Host capability, measured with raw kill(-pgid, 0) and NOT with the code under test: a container whose pid 1 never
// reaps leaves an exited orphan as a zombie, so a real group never reads ESRCH there (the Forge exec container).
const canReap = await (async () => {
  const childScript = keepAliveScript({ maxLifetimeMs: 3000, postlude: 'setTimeout(() => process.exit(0), 50);' });
  const l = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});process.exit(0)`], { detached: true, stdio: 'ignore' });
  await new Promise((r) => l.on('exit', r));
  for (let i = 0; i < 100; i++) {
    try { process.kill(-l.pid, 0); } catch (e) {
      if (e.code === 'ESRCH') return true;
      if (e.code !== 'EPERM') return false;
    }
    await realSleep(20);
  }
  return false;
})();

describe('awaitGroupDeath', () => {
  it.each([undefined, null, -2, 0, 1, 1.5, NaN, Infinity, '4242'])(
    'refuses unsafe pgid %s before probing', async (pgid) => {
      let probes = 0;
      expect(await awaitGroupDeath({ pgid, identity: 'n', probeIdentity: () => { probes++; return null; },
        killGroup: () => { probes++; throw errCode('ESRCH'); }, sleep: async () => {} })).toBe('unknown');
      expect(probes).toBe(0);
    });
  it.each([
    { probeMs: 0 }, { probeMs: -1 }, { probeMs: NaN }, { probeMs: '10' },
    { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: '10' },
    { identity: '' },
  ])('refuses invalid proof inputs %j before probing', async (patch) => {
    let probes = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => { probes++; return null; },
      killGroup: () => { probes++; throw errCode('ESRCH'); }, sleep: async () => {}, ...patch })).toBe('unknown');
    expect(probes).toBe(0);
  });
  it.skipIf(!canReap)('is dead after a straggler grandchild of a real group exits', async () => {
    const childScript = keepAliveScript({ maxLifetimeMs: 3000, postlude: 'setTimeout(() => process.exit(0), 400);' });
    const leader = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),50)`], { detached: true, stdio: 'ignore' });
    const pgid = leader.pid;
    await new Promise((r) => leader.on('exit', r));
    expect(() => process.kill(-pgid, 0)).not.toThrow(); // grandchild still alive
    const res = await awaitGroupDeath({ pgid, identity: 'n1', probeIdentity: () => null, killGroup: (p, s) => process.kill(-p, s), sleep: realSleep, probeMs: 20, timeoutMs: 3000 });
    expect(res).toBe('dead');
  }, 10_000);
  it('is alive at the timeout', async () => {
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null, killGroup: () => {}, sleep: async () => {}, probeMs: 10, timeoutMs: 30 });
    expect(res).toBe('alive');
  });
  it('is unknown on a non-ESRCH probe error (EPERM)', async () => {
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null, killGroup: () => { throw errCode('EPERM'); }, sleep: async () => {}, timeoutMs: 30 });
    expect(res).toBe('unknown');
  });
  it('keeps polling through EPERM then confirms ESRCH', async () => {
    const probes = ['EPERM', 'ESRCH'];
    let sleeps = 0;
    const res = await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { throw errCode(probes.shift()); },
      sleep: async () => { sleeps++; }, probeMs: 10, timeoutMs: 30 });
    expect(res).toBe('dead');
    expect(sleeps).toBe(1);
    expect(probes).toEqual([]);
  });
  it('bounds persistent EPERM at the timeout', async () => {
    const waits = [];
    let probes = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { probes++; throw errCode('EPERM'); },
      sleep: async (ms) => { waits.push(ms); }, probeMs: 10, timeoutMs: 25 })).toBe('unknown');
    expect(waits).toEqual([10, 10, 5]);
    expect(probes).toBe(4);
  });
  it.each([['reused', 'other'], ['unreadable', undefined]])('refuses %s identity after EPERM', async (_name, observed) => {
    const identities = [null, observed];
    let probes = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => identities.shift(),
      killGroup: () => { probes++; throw errCode('EPERM'); }, sleep: async () => {},
      probeMs: 10, timeoutMs: 30 })).toBe('unknown');
    expect(probes).toBe(1);
  });
  it('returns unknown immediately for an unexpected probe error', async () => {
    let sleeps = 0;
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { throw errCode('EIO'); }, sleep: async () => { sleeps++; } })).toBe('unknown');
    expect(sleeps).toBe(0);
  });
  it.each([{ probeMs: Infinity }, { timeoutMs: Infinity }])('refuses an unbounded retry interval %j', async (patch) => {
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => null,
      killGroup: () => { throw new Error('must not probe'); }, sleep: async () => {}, ...patch })).toBe('unknown');
  });
  it.each([['recorded live leader', 'n'], ['undefined identity evidence', undefined]])(
    'refuses ESRCH with %s', async (_name, observed) => {
      expect(await awaitGroupDeath({ pgid: 4242, identity: 'n', probeIdentity: () => observed,
        killGroup: () => { throw errCode('ESRCH'); }, sleep: async () => {} })).toBe('unknown');
    });
  it('is unknown without a recorded start identity, or when the pgid was reused', async () => {
    const dead = () => { throw errCode('ESRCH'); };
    expect(await awaitGroupDeath({ pgid: 4242, probeIdentity: () => null, killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', killGroup: dead, sleep: async () => {} })).toBe('unknown'); // no identity probe
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => 'b', killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => { throw new Error('x'); }, killGroup: dead, sleep: async () => {} })).toBe('unknown');
    expect(await awaitGroupDeath({ pgid: 4242, identity: 'a', probeIdentity: () => null, killGroup: dead, sleep: async () => {} })).toBe('dead');
  });
});

describe('decidePromotion', () => {
  const good = { exitCode: 77, groupDeath: 'dead', recordWritten: true, inFlight: 0, nowMs: 1000, expectedDigest: 'd1', candidate: { pid: 9, alive: true, ready: true, codeDigest: 'd1' } };
  it('promotes a clean handover with no wait', () => {
    expect(decidePromotion(good)).toMatchObject({ promote: true, waitMs: 0, reconcileFirst: false });
  });
  it.each([
    ['group alive', { groupDeath: 'alive' }],
    ['group unknown (EPERM)', { groupDeath: 'unknown' }],
    ['group missing', { groupDeath: undefined }],
    ['record not written', { recordWritten: false }],
    ['record missing', { recordWritten: undefined }],
    ['candidate dead', { candidate: { ...good.candidate, alive: false } }],
    ['candidate not ready', { candidate: { ...good.candidate, ready: false } }],
    ['candidate missing', { candidate: undefined }],
    ['digest mismatch', { candidate: { ...good.candidate, codeDigest: 'zz' } }],
    ['expected digest missing', { expectedDigest: undefined }],
    ['in-flight unknown', { inFlight: undefined }],
    ['in-flight negative', { inFlight: -1 }],
    ['exit code unknown', { exitCode: undefined }],
    ['exit code NaN', { exitCode: NaN }],
    ['candidate pid 0', { candidate: { ...good.candidate, pid: 0 } }],
    ['candidate pid negative', { candidate: { ...good.candidate, pid: -5 } }],
  ])('refuses on %s', (_n, patch) => {
    expect(decidePromotion({ ...good, ...patch })).toMatchObject({ promote: false });
  });
  it('an unclean blue (exit != 77, or in flight) promotes only with a settle wait and reconcile-first', () => {
    for (const patch of [{ exitCode: 1 }, { exitCode: 137 }, { inFlight: 2 }]) {
      const r = decidePromotion({ ...good, ...patch, lastSendAt: 900, ghRequestTimeoutMs: 5000 });
      expect(r).toMatchObject({ promote: true, reconcileFirst: true, waitMs: 4900 });
    }
  });
  it('forwards a caller settle wait longer than the gh timeout', () => {
    expect(decidePromotion({ ...good, exitCode: 1, lastSendAt: 900, ghRequestTimeoutMs: 5000, settleMs: 9000 }))
      .toMatchObject({ promote: true, reconcileFirst: true, waitMs: 8900 });
  });
});

describe('settleDecision', () => {
  it('is clean only on exit 77 with inFlight 0', () => {
    expect(settleDecision({ exitCode: 77, inFlight: 0, nowMs: 1 })).toMatchObject({ clean: true, waitMs: 0 });
    expect(settleDecision({ exitCode: 77, inFlight: 1, nowMs: 1 }).clean).toBe(false);
    expect(settleDecision({ exitCode: 77, nowMs: 1 }).clean).toBe(false);
  });
  it('waits at least the gh timeout after the last send, never less than the settle bound', () => {
    expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 3000, ghRequestTimeoutMs: 5000 }).waitMs).toBe(2000);
    expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 3000, ghRequestTimeoutMs: 5000, settleMs: 9000 }).waitMs).toBe(6000);
    expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 99999, ghRequestTimeoutMs: 5000 }).waitMs).toBe(0);
  });
  it('a zero, negative or NaN gh timeout falls back to the default bound', () => {
    for (const t of [0, -1, NaN, null]) expect(settleDecision({ exitCode: 1, inFlight: 0, lastSendAt: 0, nowMs: 0, ghRequestTimeoutMs: t }).waitMs).toBe(120000);
  });
  it('an unknown last-send time waits the full bound from now, and reconciles first', () => {
    expect(settleDecision({ exitCode: null, inFlight: 1, nowMs: 3000, ghRequestTimeoutMs: 5000 })).toEqual({ waitMs: 5000, reconcileFirst: true, clean: false });
  });
});

describe('mayHandOver', () => {
  const ok = { holdingLease: true, paused: false, currentChild: null, eoeIdle: true, sourcesStopped: true };
  it('allows only at a clean boundary', () => expect(mayHandOver(ok)).toEqual({ ok: true }));
  it.each([
    ['a child', { currentChild: { pid: 1 } }],
    ['eoe busy', { eoeIdle: false }],
    ['sources live', { sourcesStopped: false }],
    ['paused', { paused: true }],
    ['lease not held', { holdingLease: false }],
    ['absent state', { holdingLease: undefined }],
    ['paused field missing', { paused: undefined }],
    ['currentChild field missing', { currentChild: undefined }],
  ])('refuses with %s', (_n, patch) => expect(mayHandOver({ ...ok, ...patch }).ok).toBe(false));
});

describe('new-session spawn allowlist', () => {
  it.each([
    'const opts = Object.fromEntries([["detached", true], ["stdio", "inherit"]]); spawn(process.execPath, ["-e", workerSource], opts)',
    'spawn(process.execPath, [], Object.fromEntries(entries))',
    'spawn(process.execPath, [], Object.assign({}, supplied))',
    'spawn(process.execPath, [], JSON.parse(serialized))',
    'spawn(process.execPath, [], makeOptions())',
    'spawn(process.execPath, [], { ...supplied, stdio: "inherit" })',
    'spawn(process.execPath, [], { [key]: true })',
    'spawn(process.execPath, [], { __proto__: supplied })',
    'spawn(process.execPath, opts)',
    'spawnSync(process.execPath, [], opts)',
    'fork(workerPath, [], opts)',
    'execFile(process.execPath, [], opts, callback)',
    'execFileSync(process.execPath, [], opts)',
    'exec(command, opts, callback)',
    'execSync(command, opts)',
    'childProcess.spawn(process.execPath, [], opts)',
    'import { spawn as launch } from "node:child_process"; launch(process.execPath, [], opts)',
    'const launch = spawn; launch(process.execPath, [], opts)',
    'let launch; launch = spawn; launch(process.execPath, [], opts)',
    'const launch = spawn.bind(null); launch(process.execPath, [], opts)',
    'const { spawn: launch } = require("node:child_process"); launch(process.execPath, [], opts)',
    'import * as cp from "node:child_process"; cp[method](process.execPath, [], opts)',
    'import { spawn as launch } from "node:child_process"; function run(launch = null) {} launch(process.execPath, [], opts)',
    'spawn.call(null, process.execPath, [], opts)',
    'spawn.apply(null, callArgs)',
    'spawn(...callArgs)',
  ])('requires inspectable options before handover: %s', (source) => {
    expect(scanNewSessionSpawns(source).length).toBeGreaterThan(0);
  });
  it('does not exempt constructed options even for an allowlisted command', () => {
    expect(scanNewSessionSpawns('spawn("osascript", [], options)', { file: 'branch-sync.mjs' }).length).toBeGreaterThan(0);
  });
  it.each([
    'spawn(process.execPath)',
    'spawn(process.execPath, ["worker.mjs"])',
    'spawn(process.execPath, args, { stdio: "inherit", env, cwd })',
    'spawn(process.execPath, { stdio: "inherit" })',
    'execFile(process.execPath, args, { timeout: 1000 }, callback)',
    'exec(command, { timeout: 1000 }, callback)',
  ])('accepts inspectable inherited-group options: %s', (source) => {
    expect(scanNewSessionSpawns(source)).toEqual([]);
  });
  it('declares exactly the three known non-merging-or-disclosed spawns', () => {
    expect(MERGE_CAPABLE_SPAWN_ALLOWLIST.map((e) => e.name)).toEqual(['osascript', 'deps-job', 'drain-followup-job']);
  });
  it.each([
    ["spawn('gh', a, { detached: true })"],
    ["spawn('gh', a, { detached })"],
    ["spawn('gh', a, { stdio, detached })"],
    ["spawn('gh', a, { ['detached']: true })"],
    ["spawn('gh', a, { 'detached' : opts.d })"],
    ["spawn('setsid', ['gh'])"],
    ["subprocess.Popen(x, start_new_session=True)"],
    ["// osascript\nspawn('gh', a, { detached: true })"],
    ["spawn('gh', a, { detached: true }) // osascript"],
    ["/* deps-job */ spawn('gh', a, { detached: true })"],
    ["// lane/* base\nspawn('gh', a, { detached: true });\n/* real comment */"],
    ["const glob = 'lane/*';\nspawn('gh', a, { detached: true });\n/* real comment */"],
    ['const glob = `lane/*`;\nspawn("gh", a, { detached: true });\n/* real comment */'],
    ["opts.detached = true; spawn('gh', a, opts)"],
    ["opts['detached'] = true; spawn('gh', a, opts)"],
    ["opts[`detached`] = true; spawn('gh', a, opts)"],
    ["opts['de' + 'tached'] = true; spawn('gh', a, opts)"],
    ["opts.detached ||= true; spawn('gh', a, opts)"],
    ["opts.detached++; spawn('gh', a, opts)"],
    ["++opts['detached']; spawn('gh', a, opts)"],
    ["[opts.detached] = [true]; spawn('gh', a, opts)"],
    ["({ value: opts.detached } = source); spawn('gh', a, opts)"],
    ["Object.defineProperty(opts, 'detached', { value: true }); spawn('gh', a, opts)"],
    ["Reflect.set(opts, 'detached', true); spawn('gh', a, opts)"],
    ["spawn('gh', a, { get detached() { return true; } })"],
    ["spawn('gh', a, { ['de' + 'tached']: true })"],
    ["spawn('gh', a, { ['de\\u0074ached']: true })"],
    ["spawn('launch' + 'ctl', ['submit', '-l', 'job', '--', 'gh'])"],
    ['spawn(`launch${"ctl"}`, ["submit"])'],
    ['spawn("sh", ["-c", `launchctl submit -l job -- ${command}`])'],
    ['spawn("sh", ["-c", `${prefix} launchctl submit -- ${command}`])'],
    ['spawn("sh", ["-c", `${prefix} launchctl submit -- gh`])'],
    ["spawn('launchctl', ['submit', '-l', 'job', '--', 'gh', 'pr', 'merge'])"],
    ["spawn('/bin/sh', ['-c', 'launchctl submit -l job -- gh pr merge'])"],
    ["setpgid(0, 0)"],
    ["setpgrp()"],
    ["// lane/* base\r\nspawn('gh', a, { detached: true });\r\n/* real comment */"],
    ["// lane/* base\u2028spawn('gh', a, { detached: true });\u2029/* real comment */"],
    ['const url = "https://example.test/lane/*";\nspawn("gh", a, { detached: true });\n/* real comment */'],
    ['const glob = /lane\\/\\*/;\nspawn("gh", a, { detached: true });\n/* real comment */'],
    ['const glob = `lane/* ${spawn("gh", a, { detached: true })}`;\n/* real comment */'],
    ['spawn(process.execPath, ["-e", "spawn(\'gh\', a, { detached: true })"])'],
    ['const childSource = "opts[\'detached\'] = true; spawn(\'gh\', a, opts)"'],
  ])('flags %s', (src) => expect(scanNewSessionSpawns(src)).toHaveLength(1));
  it.each(['osascript', 'deps-job'])('rejects a detached spawn adjacent to %s', (command) => {
    const file = command === 'osascript' ? 'branch-sync.mjs' : 'deps-job.mjs';
    const src = `spawn('${command}', a, { detached: true });\nspawn('gh', a, { detached: true });`;
    expect(scanNewSessionSpawns(src, { file })).toEqual([{ line: 2, text: 'detached: true' }]);
    expect(scanNewSessionSpawns(`const kind = '${command}';\nlog(kind);\nspawn('gh', a, { detached: true });`, { file })).toHaveLength(1);
    expect(scanNewSessionSpawns(src.replace('\n', ' '), { file })).toHaveLength(1);
  });
  it('never borrows an exemption from another argument or a containing spawn', () => {
    const file = 'branch-sync.mjs';
    expect(scanNewSessionSpawns("spawn('gh', ['osascript'], { detached: true })", { file })).toHaveLength(1);
    expect(scanNewSessionSpawns("spawn('osascript', [spawn('gh', a, { detached: true })], { detached: true })", { file })).toHaveLength(1);
    expect(scanNewSessionSpawns("spawn('osascript', a, { detached: opts.detached = true })", { file })).toHaveLength(1);
    expect(scanNewSessionSpawns("spawn('osascript', a, { detached: launchctl() })", { file })).toHaveLength(1);
  });
  it('refuses exemptions without the declared file and exact command', () => {
    const src = "spawn('osascript', a, { detached: true })";
    expect(scanNewSessionSpawns(src)).toHaveLength(1);
    expect(scanNewSessionSpawns(src, { file: 'other.mjs' })).toHaveLength(1);
    expect(scanNewSessionSpawns("spawn('gh', ['deps-job'], { detached: true })", { file: 'deps-job.mjs' })).toHaveLength(1);
  });
  it.each([undefined, null, 'spawn("gh", a, { detached: true'])('fails closed on unreadable source %s', (source) => {
    expect(scanNewSessionSpawns(source)).toHaveLength(1);
  });
  it('exempts only an allowlisted spawn on its own code line, and prose is not a spawn', () => {
    expect(scanNewSessionSpawns("spawn('osascript', a, { detached: true })", { file: 'branch-sync.mjs' })).toHaveLength(0);
    expect(scanNewSessionSpawns("branch || 'detached HEAD'; const detached = x == null;")).toHaveLength(0);
    // the follow-up allowlist entry applies to its own file only
    const src = 'spawn(process.execPath, [entryPath], { cwd, env, detached: true })';
    expect(scanNewSessionSpawns(src, { file: 'daemon-jobs-runtime.mjs' })).toHaveLength(0);
    expect(scanNewSessionSpawns(src, { file: 'other.mjs' })).toHaveLength(1);
    expect(scanNewSessionSpawns(`${src}; spawn('gh', a, { detached: true })`, { file: 'daemon-jobs-runtime.mjs' })).toHaveLength(1);
    expect(scanNewSessionSpawns("spawn(process.execPath, [entryPath, 'gh'], { detached: true })", { file: 'daemon-jobs-runtime.mjs' })).toHaveLength(1);
  });
  it('detects canary detached spawns throughout every real scanned file', () => {
    const files = ['merge-ai-prs.mjs', 'lib/enqueue-on-event.mjs', 'lib/drain-followup-job.mjs', 'lib/daemon-jobs-runtime.mjs'];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      expect(tree.parseDiagnostics, file).toEqual([]);
      const positions = [];
      const collect = (node) => {
        if (ts.isBlock(node) || ts.isSourceFile(node)) positions.push(...node.statements.map((s) => s.getStart(tree)));
        ts.forEachChild(node, collect);
      };
      collect(tree);
      const sorted = [...new Set(positions)].sort((a, b) => a - b);
      const stride = Math.max(1, Math.floor(sorted.length / 16));
      for (const position of sorted.filter((_p, i) => i % stride === 0)) {
        const canary = "spawn('gh', ['pr', 'merge'], { detached: true });\n";
        const injected = source.slice(0, position) + canary + source.slice(position);
        const line = tree.getLineAndCharacterOfPosition(position).line + 1;
        expect(scanNewSessionSpawns(injected, { file: file.split('/').pop() }), `${file}:${line}`)
          .toContainEqual({ line, text: 'detached: true' });
      }
    }
  });
  it.each([0, 2])('requires additional evidence for opaque forwarding in the real source inventory (prefix lines: %i)', (prefixLines) => {
    const files = ['merge-ai-prs.mjs', 'lib/enqueue-on-event.mjs', 'lib/drain-followup-job.mjs', 'lib/daemon-jobs-runtime.mjs'];
    // the sibling repo's daemon.mjs is out of reach for a hermetic test: its scan is the live PGID probe (acceptance 6)
    // These are REFUSALS, not allowlist entries. The old empty-result expectation incorrectly certified
    // opaque bags; S1.4 cannot enable exit handover until these sites have inspectable options/evidence.
    const unresolved = [
      'exec(cmd, args, { cwd, ...opts })',
      'exec(cmd, args, { cwd, ...opts })',
      "exec('gh', ['pr', 'view', String(pr), ...(repo ? ['--repo', repo] : []),\n    '--json', 'headRefOid'], opts)",
      "exec('gh', GH_ARGV.readPrReviews(slug, pr), opts)",
      'execFileSync(cmd, args, { ...opts, timeout: 60_000 })',
      'execFileSync(cmd, args, { ...opts, timeout: 60_000 })',
      'execFileSync(file, args, { ...opts, cwd })',
      'execFileSync(cmd, args, { cwd: escCwd, ...opts })',
    ];
    for (const f of files) {
      const original = readFileSync(join(root, f), 'utf8');
      // A hashbang is valid only at the start of the source. Shift the body without moving it.
      const prefixOffset = original.startsWith('#!') ? original.indexOf('\n') + 1 : 0;
      const source = original.slice(0, prefixOffset) + '\n'.repeat(prefixLines) + original.slice(prefixOffset);
      const tree = ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      expect(tree.parseDiagnostics, `${f}: line-shift fixture must remain valid JavaScript`).toEqual([]);
      // Locate each audited call independently of the scanner, preserving duplicate occurrences.
      // Unrelated line shifts must not change the inventory, but missing/new calls must still fail.
      let offset = 0;
      const expected = f === 'merge-ai-prs.mjs' ? unresolved.map((text) => {
        const position = source.indexOf(text, offset);
        expect(position, `${f}: missing audited call ${text}`).toBeGreaterThanOrEqual(0);
        offset = position + text.length;
        return {
          line: source.slice(0, position).split('\n').length,
          text: `Uninspectable process options; inspect before permitting handover: ${text}`,
        };
      }) : [];
      expect(scanNewSessionSpawns(source, { file: f.split('/').pop() }), f).toEqual(expected);
    }
  });
});
