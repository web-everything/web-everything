/** PR #6945: ownership must stay revoked across pending and overlapping cache writes. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Inject filesystem errors in a child so builtin patches cannot leak to other tests. */
export function markerCreationFailure(code, { retainedLock = true } = {}) {
  const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
  const moduleUrl = pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href;
  const dir = mkdtempSync(join(tmpdir(), 'host-marker-failure-'));
  const path = join(dir, 'cache.json');
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const path = ${JSON.stringify(path)};
      const retainedLock = ${JSON.stringify(retainedLock)};
      if (retainedLock) fs.mkdirSync(path + '.lock');
      const write = fs.writeFileSync;
      let failures = 0;
      fs.writeFileSync = (target, ...args) => {
        if (target === path + '.lock/blocked' || (!retainedLock && target.endsWith('.tmp')
          && !target.startsWith(path + '.lock.fence.'))) {
          failures += 1;
          throw Object.assign(new Error('injected filesystem failure'), { code: ${JSON.stringify(code)} });
        }
        return write(target, ...args);
      };
      syncBuiltinESMExports();
      const { resolveHostRole, readCacheFile, writeCacheFile, invalidateCacheFile } = await import(${JSON.stringify(moduleUrl)});
      let reads = 0;
      const decision = await resolveHostRole({ thisHost: 'a', now: 1800000000000, atStart: true, state: {},
        readCache: () => readCacheFile(path), writeCache: (value) => writeCacheFile(value, path),
        invalidateCache: (value) => invalidateCacheFile(path, value),
        readRemote: () => { reads += 1; return { status: 'ok', owner: 'a' }; } });
      process.stdout.write(JSON.stringify({ decision, failures, reads,
        lockExists: fs.existsSync(path + '.lock'), markerExists: fs.existsSync(path + '.lock/blocked') }));
    `], { timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    if (child.status !== 0) throw new Error(`fault injection failed: ${child.error ?? child.stderr}`);
    return JSON.parse(child.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A live holder resumes after the contender's one-second deadline. */
export async function liveHolderContention(markerError, { phase = 'publish', holderFails = false, invalidate = false } = {}) {
  const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
  const moduleUrl = pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href;
  const { readCacheFile, resolveHostRole, writeCacheFile, invalidateCacheFile } = await import(moduleUrl);
  const { cliIO } = await import(pathToFileURL(join(root, 'scripts/operations/daemon-preflight.mjs')).href);
  const home = mkdtempSync(join(tmpdir(), 'host-live-holder-'));
  const path = join(home, '.claude', 'daemon-host-guard', 'cache.json');
  const release = join(home, 'release');
  const now = 1_800_000_000_000;
  const violations = [];
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const operation = ${JSON.stringify(phase === 'cleanup' ? 'rmdirSync' : 'renameSync')};
    const original = fs[operation];
    fs[operation] = (...args) => {
      process.send('paused'); const deadline = Date.now() + 8000;
      while (!fs.existsSync(${JSON.stringify(release)})) {
        if (Date.now() > deadline) throw new Error('release timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      if (${holderFails}) throw Object.assign(new Error('holder failure after revocation'), { code: 'EACCES' });
      return original(...args);
    };
    syncBuiltinESMExports();
    const { resolveHostRole, readCacheFile, writeCacheFile, invalidateCacheFile } = await import(${JSON.stringify(moduleUrl)});
    const path = ${JSON.stringify(path)};
    const decision = await resolveHostRole({ thisHost: 'a', now: ${now}, atStart: true, state: {},
      readCache: () => readCacheFile(path), writeCache: (value) => writeCacheFile(value, path),
      invalidateCache: (value) => invalidateCacheFile(path, value),
      readRemote: () => ({ status: 'ok', owner: 'a' }) });
    process.exitCode = decision.role === 'standby' ? 0 : 2;
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(holder, 'exit');
  try {
    await once(holder, 'message', { signal: AbortSignal.timeout(10000) });
    // Wait for the contender to actually fence the holder, rather than relying
    // on scheduler timing or releasing before the one-second deadline.
    const contender = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const path = ${JSON.stringify(path)};
      const markerError = ${JSON.stringify(markerError ?? null)};
      let failures = 0;
      const write = fs.writeFileSync;
      fs.writeFileSync = (target, ...args) => {
        if (markerError && target === path + '.lock/blocked') {
          failures += 1;
          throw Object.assign(new Error('injected marker failure'), { code: markerError });
        }
        return write(target, ...args);
      };
      syncBuiltinESMExports();
      const { resolveHostRole, readCacheFile, writeCacheFile, invalidateCacheFile } = await import(${JSON.stringify(moduleUrl)});
      const state = {};
      const decision = await resolveHostRole({ thisHost: 'a', now: ${now + 1}, atStart: true, state,
        readCache: () => readCacheFile(path), writeCache: (value) => {
          if (${invalidate}) throw new Error('handoff persistence failed');
          return writeCacheFile(value, path);
        },
        invalidateCache: (value) => invalidateCacheFile(path, value),
        readRemote: () => ({ status: 'ok', owner: 'b' }) });
      process.stdout.write(JSON.stringify({ decision, failures, poisoned: state.hosts.get('a').cacheInvalidated }));
    `], { timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    if (contender.status !== 0) throw new Error(`contender failed: ${contender.error ?? contender.stderr}`);
    const result = JSON.parse(contender.stdout);
    if (markerError && (result.failures < 1 || result.decision.reason !== 'fence-unenforceable' || !result.poisoned)) {
      violations.push(`marker ${markerError} denial was not observable and poisoned: ${contender.stdout}`);
    }
    if (!markerError && !existsSync(join(`${path}.lock`, 'blocked'))) {
      violations.push('live holder was not fenced after bounded contention');
    }
    writeFileSync(release, '');
    const [code] = await exited;
    if (code !== 0 || (!holderFails && JSON.parse(readFileSync(path, 'utf8')).owner !== 'a')) {
      violations.push('live holder did not report denial after completing or failing publication');
    }
    if (phase === 'cleanup' && !holderFails && existsSync(`${path}.lock`)) {
      violations.push('cleanup race did not remove the ordinary lock');
    }
    let denied = false;
    try { readCacheFile(path); } catch { denied = true; }
    if (!denied) violations.push('resumed live holder left usable stale cache evidence');
    const independent = await resolveHostRole({ thisHost: 'a', now: now + 60_002, state: {},
      readCache: () => readCacheFile(path), writeCache: (value) => writeCacheFile(value, path),
      readRemote: () => ({ status: 'error' }) });
    if (independent.role !== 'standby') {
      violations.push(`independent guard reactivated after marker ${markerError ?? 'success'}: ${JSON.stringify(independent)}`);
    }
    const decision = await resolveHostRole({ thisHost: 'a', now: now + 2, atStart: true, state: {},
      readCache: () => readCacheFile(path), writeCache: (value) => writeCacheFile(value, path),
      invalidateCache: (value) => invalidateCacheFile(path, value),
      readRemote: () => ({ status: 'ok', owner: 'a' }) });
    if (decision.role !== 'standby') violations.push('retained lock allowed ownership before operator recovery');
    const diagnostic = cliIO({ HOME: home }).cacheLock?.();
    if (diagnostic?.ok !== false || !diagnostic.detail.includes(`${path}.lock`)
      || !/stop.*writers.*inspect/i.test(diagnostic.detail)) {
      violations.push('preflight did not report retained live-holder lock and operator recovery');
    }
    return { violations };
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

export default {
  id: 'host-handoff-cache-write-race',
  title: 'A failed or overlapping cache write cannot resurrect ownership after handoff',
  card: 'PR #6945 / x2fybk1',
  fixedBy: { sha: 'PR #6945 repair', where: 'lane/daemon-host-guard',
    paths: ['scripts/lib/daemon-host-guard.mjs', 'scripts/operations/daemon-preflight.mjs'] },
  fixPresent(root) {
    // Independent behavioral check, including the actual on-disk cache fallback.
    const script = `import b from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};
      const report = await b.run(); process.exitCode = b.judge(report).length ? 1 : 0;`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, SOAK_TREE_ROOT: root }, encoding: 'utf8', timeout: 20_000,
      maxBuffer: 1024 * 1024,
    }).status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { resolveHostRole, readCacheFile, writeCacheFile, invalidateCacheFile, FRESH_READ_MS } =
      await import(pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'host-handoff-soak-'));
    const path = join(dir, 'cache.json');
    const now = 1_800_000_000_000;
    const offline = () => ({ status: 'error' });
    const violations = [];
    try {
      // Empty-cache callers, including startup, must await one ownership read.
      let reads = 0;
      const reading = deferred();
      const concurrentOptions = { thisHost: 'a', now, state: {}, readCache: () => readCacheFile(path),
        writeCache: (value) => writeCacheFile(value, path),
        readRemote: () => { reads += 1; return reading.promise; } };
      const concurrent = Promise.all(Array.from({ length: 3 }, () => resolveHostRole(concurrentOptions)));
      await Promise.resolve();
      reading.resolve({ status: 'ok', owner: 'a' });
      const decisions = await concurrent;
      if (reads !== 1 || decisions.some((decision) => JSON.stringify(decision) !== JSON.stringify(decisions[0]))) {
        violations.push(`concurrent calls: ${reads} reads, decisions=${JSON.stringify(decisions)}`);
      }

      // Separate guard states can read the same host-local file. The older
      // response must neither replace a confirmed handoff nor enable offline use.
      for (const handoff of [{ status: 'ok', owner: 'b' }, { status: 'unset' }]) {
        for (const fails of [false, true]) {
          invalidateCacheFile(path);
          const reading = deferred();
          const started = deferred();
          const options = { thisHost: 'a', now, atStart: true,
            writeCache: (value) => writeCacheFile(value, path),
            invalidateCache: (value) => invalidateCacheFile(path, value) };
          const old = resolveHostRole({ ...options, state: {}, readCache: () => readCacheFile(path),
            readRemote: () => { started.resolve(); return reading.promise; } });
          await started.promise;
          await resolveHostRole({ ...options, state: {}, now: now + 1, readCache: () => readCacheFile(path),
            readRemote: () => handoff,
            ...(fails ? { writeCache: () => { throw new Error('disk full'); } } : {}) });
          reading.resolve({ status: 'ok', owner: 'a' });
          const late = await old;
          const offlineDecision = await resolveHostRole({ ...options, state: {}, atStart: false,
            now: now + FRESH_READ_MS + 2, readCache: () => readCacheFile(path), readRemote: offline });
          if (late.role !== 'standby' || offlineDecision.role !== 'standby' || readCacheFile(path).owner === 'a') {
            violations.push(`separate states resurrected ownership after ${handoff.status} handoff (write fails=${fails})`);
          }
        }
      }
      for (const fails of [false, true]) {
        invalidateCacheFile(path);
        writeCacheFile({ host: 'a', owner: 'a', status: 'ok', readAt: now, writtenAt: now }, path);
        const writing = deferred();
        const started = deferred();
        const options = { thisHost: 'a', now, atStart: true, state: {},
          readCache: () => readCacheFile(path), invalidateCache: (value) => invalidateCacheFile(path, value) };
        const old = resolveHostRole({ ...options, readRemote: () => ({ status: 'ok', owner: 'a' }),
          writeCache: async (value) => { started.resolve(); await writing.promise; return writeCacheFile(value, path); } });
        await started.promise;
        const handoffState = {};
        const handoff = resolveHostRole({ ...options, state: handoffState, now: now + 1,
          readRemote: () => ({ status: 'ok', owner: 'b' }), writeCache: (value) => {
            if (fails) throw new Error('disk full');
            return writeCacheFile(value, path);
          } });
        await Promise.resolve();
        await Promise.resolve();
        const during = resolveHostRole({ ...options, state: handoffState, now: now + 2,
          atStart: false, readRemote: offline });
        writing.resolve();
        await Promise.all([old, handoff]);
        const after = await resolveHostRole({ ...options, state: handoffState, now: now + FRESH_READ_MS + 3,
          atStart: false, readRemote: offline });
        // A new guard must also stay closed when removal or replacement succeeded.
        const restarted = await resolveHostRole({ ...options, state: {}, now: now + FRESH_READ_MS + 3,
          atStart: false, readRemote: offline });
        for (const [phase, decision] of [['pending', await during], ['offline', after], ['restart', restarted]]) {
          if (decision.role !== 'standby') violations.push(`${phase}: ownership resurrected (write fails=${fails})`);
        }
      }
      invalidateCacheFile(path);
      const oldestRead = deferred();
      const readStarted = deferred();
      const failedWrite = deferred();
      const writeStarted = deferred();
      const sharedFile = { thisHost: 'a', now, atStart: true,
        writeCache: (value) => writeCacheFile(value, path),
        invalidateCache: (value) => invalidateCacheFile(path, value) };
      const oldest = resolveHostRole({ ...sharedFile, state: {}, readCache: () => readCacheFile(path),
        readRemote: () => { readStarted.resolve(); return oldestRead.promise; } });
      await readStarted.promise;
      const failed = resolveHostRole({ ...sharedFile, state: {}, now: now + 1,
        readCache: () => readCacheFile(path), readRemote: () => ({ status: 'ok', owner: 'b' }),
        writeCache: () => { writeStarted.resolve(); return failedWrite.promise; } });
      await writeStarted.promise;
      await resolveHostRole({ ...sharedFile, state: {}, now: now + 2,
        readCache: () => readCacheFile(path), readRemote: () => ({ status: 'ok', owner: 'b' }) });
      failedWrite.reject(new Error('late disk failure'));
      await failed;
      oldestRead.resolve({ status: 'ok', owner: 'a' });
      const lateDecision = await oldest;
      const afterFailure = await resolveHostRole({ ...sharedFile, state: {}, atStart: false,
        now: now + FRESH_READ_MS + 3, readCache: () => readCacheFile(path), readRemote: offline });
      if (lateDecision.role !== 'standby' || afterFailure.role !== 'standby') {
        violations.push('failed handoff invalidation erased newer evidence and resurrected ownership');
      }
      // Reproduce a real process pausing after its cache comparison. A second
      // process must finish its newer handoff after that holder, never before it.
      invalidateCacheFile(path);
      const release = join(dir, 'release');
      const moduleUrl = pathToFileURL(join(root, 'scripts/lib/daemon-host-guard.mjs')).href;
      const record = { host: 'a', owner: 'a', status: 'ok', readAt: now, writtenAt: now };
      const old = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        const rename = fs.renameSync;
        fs.renameSync = (...args) => {
          process.send('paused'); const deadline = Date.now() + 5000;
          while (!fs.existsSync(${JSON.stringify(release)})) {
            if (Date.now() > deadline) throw new Error('release timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          return rename(...args);
        };
        syncBuiltinESMExports();
        const { writeCacheFile } = await import(${JSON.stringify(moduleUrl)});
        writeCacheFile(${JSON.stringify(record)}, ${JSON.stringify(path)});
      `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const oldExit = once(old, 'exit');
      let newer;
      try {
        await once(old, 'message');
        newer = spawn(process.execPath, ['--input-type=module', '-e', `
          import { writeCacheFile } from ${JSON.stringify(moduleUrl)};
          process.send('writing');
          writeCacheFile(${JSON.stringify({ ...record, owner: 'b', readAt: now + 1, writtenAt: now + 1 })}, ${JSON.stringify(path)});
        `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const newerExit = once(newer, 'exit');
        await once(newer, 'message');
        await new Promise((resolve) => setTimeout(resolve, 50));
        writeFileSync(release, '');
        const codes = await Promise.all([oldExit, newerExit]);
        if (codes.some(([code]) => code !== 0) || readCacheFile(path).owner !== 'b') {
          violations.push('independent process overwrote a newer handoff after resuming');
        }
      } finally { old.kill(); newer?.kill(); }
      violations.push(...(await liveHolderContention()).violations);
      for (const code of ['ENOSPC', 'EACCES']) {
        for (const options of [{}, { phase: 'cleanup' }, { holderFails: true }, { phase: 'cleanup', holderFails: true }, { invalidate: true }]) {
          violations.push(...(await liveHolderContention(code, options)).violations);
        }
        const result = markerCreationFailure(code);
        if (result.failures !== 1 || result.reads !== 1 || result.decision.role !== 'standby'
          || !result.lockExists || result.markerExists) {
          violations.push(`retained lock allowed fresh activation when marker creation throws ${code}`);
        }
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
