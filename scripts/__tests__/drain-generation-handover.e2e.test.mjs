import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepAliveScript } from '../lib/test-keepalive.mjs';
import { awaitGroupDeath, decidePromotion } from '../lib/daemon-generation-barrier.mjs';
import { acquireDrainLease, releaseDrainLease, localRepoSlug } from '../readiness/drain-lock.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killers = [];
afterEach(() => { for (const pgid of killers.splice(0)) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } } });

// A detached "blue" leader starts a NON-detached grandchild that appends `blue-merge` lines every 20 ms for
// ~1 s, and the leader exits first: the group outlives its leader, exactly the straggler case.
const grandchildSrc = (sink) => `const fs=require('node:fs');const t=setInterval(()=>fs.appendFileSync(${JSON.stringify(sink)},'blue-merge\\n'),20);setTimeout(()=>{clearInterval(t);process.exit(0)},1000)`;
const leaderSrc = (sink) => `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchildSrc(sink))}],{stdio:'ignore'});setTimeout(()=>process.exit(0),150)`;

async function startBlue(sink) {
  const leader = spawn(process.execPath, ['-e', leaderSrc(sink)], { detached: true, stdio: 'ignore' });
  killers.push(leader.pid);
  await new Promise((r) => leader.on('exit', r));
  return leader.pid;
}

const candidate = { pid: 4321, alive: true, ready: true, codeDigest: 'd1' };
const decide = (groupDeath) => decidePromotion({ exitCode: 77, groupDeath, recordWritten: true, inFlight: 0, nowMs: 0, expectedDigest: 'd1', candidate });

/** Green acts only after `go`, which exists only if the barrier said so. `awaitDeath` is injectable for the mutation proof. */
async function runHandover(sink, awaitDeath) {
  const pgid = await startBlue(sink);
  const groupDeath = await awaitDeath({ pgid, identity: 'spawn-nonce', probeIdentity: () => null, killGroup: (p, s) => process.kill(-p, s), sleep, probeMs: 20, timeoutMs: 15000 });
  const verdict = decide(groupDeath);
  if (verdict.promote) appendFileSync(sink, 'green-merge\n');
  return { groupDeath, verdict, lines: readFileSync(sink, 'utf8').trim().split('\n') };
}

// A container whose pid 1 never reaps leaves an exited orphan as a zombie that keeps `kill(-pgid, 0)` alive for
// ever (fail closed: 'alive'); the ordering test needs a host that reaps (the drain host, CI), so it skips there.
const canReap = await (async () => {
  const childScript = keepAliveScript({ maxLifetimeMs: 3000, postlude: 'setTimeout(() => process.exit(0), 50);' });
  const l = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});process.exit(0)`], { detached: true, stdio: 'ignore' });
  await new Promise((r) => l.on('exit', r));
  for (let i = 0; i < 100; i++) {
    try { process.kill(-l.pid, 0); } catch (e) {
      if (e.code === 'ESRCH') return true;
      if (e.code !== 'EPERM') return false;
    }
    await sleep(20);
  }
  return false; // measured with raw kill(-pgid, 0), never with the barrier under test
})();

describe('generation handover (ordered exit)', () => {
  it.skipIf(!canReap)('no green effect is recorded before the last blue-group effect', async () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'gen-handover-')), 'sink.log');
    writeFileSync(sink, '');
    const { verdict, lines } = await runHandover(sink, awaitGroupDeath);
    expect(verdict.promote).toBe(true);
    expect(lines.filter((l) => l === 'blue-merge').length).toBeGreaterThan(5);
    expect(lines.lastIndexOf('blue-merge')).toBeLessThan(lines.indexOf('green-merge'));
  }, 30_000);

  it('mutation proof: with awaitGroupDeath stubbed to "dead" the ordering is violated', async () => {
    const sink = join(mkdtempSync(join(tmpdir(), 'gen-handover-mut-')), 'sink.log');
    writeFileSync(sink, '');
    const { lines } = await runHandover(sink, async () => 'dead');
    await sleep(1200); // let the straggler finish so the interleave is visible
    const all = readFileSync(sink, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all.lastIndexOf('blue-merge')).toBeGreaterThan(all.indexOf('green-merge')); // the invariant test would FAIL here
  }, 30_000);

  it('an --under-lease child of the old owner makes zero gh calls after the lease changes owner', () => {
    const home = mkdtempSync(join(tmpdir(), 'gen-home-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const ghLog = join(home, 'gh.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> ${ghLog}\necho '[]'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const lockRoot = join(home, '.claude', 'drain-locks');
    const repoKey = localRepoSlug({ cwd: repoRoot });
    const run = (declared) => {
      writeFileSync(ghLog, '');
      return spawnSync(process.execPath, [join(repoRoot, 'scripts', 'merge-ai-prs.mjs'), '--label=ready-to-merge', `--under-lease=${declared}`, '--json'], {
        cwd: repoRoot, encoding: 'utf8', timeout: 90_000,
        env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, DRAIN_UNDER_LEASE: '' },
      });
    };
    // The pass reaches gh either through the fake on PATH (argv logged) or, when the host's gh shim refuses an
    // unauthenticated daemon caller before exec'ing it, as a `gh pr list` attempt named in the pass's own output.
    let last = null;
    const calls = () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length + (/gh pr list/.test(`${last?.stdout}${last?.stderr}`) ? 1 : 0);

    // Positive control: the declared owner holds the lease, so the pass starts and reaches gh.
    expect(acquireDrainLease(lockRoot, 'host:1:old-owner', { repoKey }).ok).toBe(true);
    last = run('host:1:old-owner');
    expect(calls()).toBeGreaterThan(0);

    // The lease changes owner (new generation): the old owner's child must no-op before any gh call.
    releaseDrainLease(lockRoot, 'host:1:old-owner', { repoKey });
    expect(acquireDrainLease(lockRoot, 'host:2:new-owner', { repoKey }).ok).toBe(true);
    const res = run('host:1:old-owner');
    last = res;
    expect(calls()).toBe(0);
    expect(res.stdout + res.stderr).toMatch(/drain-in-progress|no-op|no longer holds|already holds/);
  }, 200_000);
});
