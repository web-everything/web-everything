/** Full local CI test gate, sequential heavy admission, runner-authored receipts only. */
import { randomBytes } from 'node:crypto';
import * as realFs from 'node:fs';
import { spawnSync as realSpawn } from 'node:child_process';
import { hostname, homedir, tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { ciUnitPlan, ciGatePlan, urgentLedger, urgentKeyPath, urgentSignature, normalizeUrgentRepo, urgentFuiRepo, canonicalFuiRepo } from './urgent-verify-marker.mjs';

const worktreePrefix = '.urgent-verify-';
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// `decorate(deps, dir)` is a test seam: it may replace step functions of the scoped (worktree) deps.
// `isolated: true` (the CLI default via urgentVerify) adds `isolate`; scoped deps are created with false so they never nest.
export function createUrgentDeps({ cwd = process.cwd(), home = homedir(), fs = realFs, spawnSync = realSpawn, env = process.env, decorate, isolated = false, stepHome, wrapperRoot, maxMinutes, deadline } = {}) {
  // Wall-clock limit for the whole run (setting urgentVerify.maxMinutes via WE_URGENT_VERIFY_MAX_MINUTES, default 40).
  // Scoped (worktree) deps inherit the parent's deadline so the limit covers the run, not each child.
  const limitMin = Math.min(240, Math.max(0.01, Number(maxMinutes ?? env.WE_URGENT_VERIFY_MAX_MINUTES) || 40));
  deadline ??= Date.now() + limitMin * 60_000;
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SHELL', 'USER']
    .filter(k => typeof env[k] === 'string' && !env[k].includes(urgentKeyPath(home))).map(k => [k, env[k]]));
  // Local verification must acquire host admission even when launched from CI.
  for (const marker of ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION', 'GITLAB_CI',
    'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD', 'BUILD_NUMBER']) delete childEnv[marker];
  // The host's approved gh-shim dirs (the agent-launch shim: <home>/.claude/github-app-token/gh-shim or gh-shim.d/<16 hex>)
  // are launcher scaffolding, not system tools: scrub exactly those from the child PATH so nothing probes the token tree.
  // Any other extra dir (a lookalike, another gh) is left alone.
  // Matched by the exact path shape (any home: the host PATH is inherited while HOME may be a sandbox or fake).
  // Exact shape `<some home>/.claude/github-app-token/gh-shim` or `.../gh-shim.d/<16 hex>`, and never inside the checkout
  // or its sibling checkouts' tree: a repo-supplied lookalike is not exempt and stays probed. (HOME is a sandbox in
  // wrapped runs, so the home itself cannot be the anchor.)
  const checkoutRoot = resolve(cwd);
  const approvedShimDir = d => {
    const r = resolve(d);
    if (r === checkoutRoot || r.startsWith(checkoutRoot + '/')) return false;
    const m = /^(.+)\/\.claude\/github-app-token\/(gh-shim|gh-shim\.d\/[0-9a-f]{16})$/.exec(r);
    return Boolean(m) && !m[1].includes('/.claude/');
  };
  const fui = resolve(cwd, '../frontierui');
  // Child env is scrubbed to a few keys; local bins (vitest etc.) must stay resolvable.
  const binDirs = [join(cwd, 'node_modules/.bin'), join(fui, 'node_modules/.bin')];
  // Appended (not prepended) so checkout-local binaries can never shadow system git/sh/npm.
  const systemPath = childEnv.PATH ?? '';
  childEnv.PATH = [childEnv.PATH, ...binDirs].filter(Boolean).join(delimiter);
  // Resolve before changing HOME or cwd; ~/ overrides and relative paths belong to the caller.
  const admissionPool = resolve(cwd, defaultPoolRoot(cwd, env));
  const run = (cmd, args, dir = cwd) => {
    // The checkout under test may predate the child-env strip, so its wrapper is the runner's own copy.
    if (wrapperRoot && String(args[0]).endsWith('heavy-admission.mjs')) args = [join(wrapperRoot, 'scripts/readiness/heavy-admission.mjs'), ...args.slice(1)];
    // Checkout-local bins only for the admission wrapper that runs vitest/npm; git, gh and plain node calls
    // (which decide trust, e.g. the FUI origin) get the system PATH so a local replacement cannot shadow them.
    // Checkout code (the wrapper's children) gets the throwaway HOME, never the real one that holds the signing key.
    const wrapper = String(args[0]).endsWith('heavy-admission.mjs');
    const env = wrapper ? { ...childEnv, LANE_POOL_ROOT: admissionPool, WE_STRIP_POOL_ROOT_FROM_CHILD: '1', ...(stepHome ? { HOME: stepHome, npm_config_cache: join(home, '.npm') } : {}) } : { ...childEnv, PATH: systemPath };
    // Own process group (detached) so an expired child's whole tree dies, and only that tree: -pid is our spawn's group.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const late = new Error(`urgent-verify wall-clock limit (${limitMin} min) expired before: ${cmd} ${args.join(' ')}`);
      late.failure = { cmd: [cmd, ...args].join(' ').slice(0, 300), exit: null, timedOut: true, limitMinutes: limitMin, stderrTail: '' };
      throw late;
    }
    // SIGKILL (not the SIGTERM default) so a child that traps TERM cannot delay the expiry.
    const r = spawnSync(cmd, args, { cwd: dir, env, encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, detached: true });
    const timedOut = r.error?.code === 'ETIMEDOUT';
    // Any spawn error (timeout, buffer overflow) may leave descendants: kill the group we created, nothing else.
    if (r.error && Number.isInteger(r.pid) && r.pid > 1) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* already gone */ } }
    if (r.error || r.status !== 0) {
      const bytes = Buffer.from(String(r.stderr ?? '').split(/\r?\n/).filter(Boolean).slice(-20).join('\n'));
      let start = Math.max(0, bytes.length - 8192);
      // Keep a suffix of at most 8 KiB without splitting a UTF-8 character.
      for (; start < bytes.length && (bytes[start] & 0xc0) === 0x80; start++) { /* continuation byte */ }
      const tail = bytes.subarray(start).toString('utf8');
      const err = new Error(`urgent-verify subprocess failed or admission unavailable (exit ${r.status ?? r.error?.code ?? 'unknown'}): ${cmd} ${args.join(' ')}`);
      err.failure = { cmd: [cmd, ...args].join(' ').slice(0, 300), exit: r.status ?? null, error: r.error ? String(r.error.message ?? r.error) : undefined, stderrTail: tail, ...(timedOut ? { timedOut: true, limitMinutes: limitMin } : {}) };
      err.stdout = String(r.stdout ?? '');
      throw err;
    }
    return r.stdout;
  };
  let gates;
  const heavy = (args, dir = cwd) => run(process.execPath, [dir === cwd ? 'scripts/readiness/heavy-admission.mjs' : join(cwd, 'scripts/readiness/heavy-admission.mjs'), 'run', '--wait-ms=60000', '--require-admission', '--', ...args], dir);
  // Every step runs in a private checkout pinned to the sha, so other writers in the caller's checkout
  // cannot change the verdict. It is a standalone repo (own .git dir, objects borrowed read-only via
  // alternates), NOT a linked worktree: a linked worktree's gitdir lives inside the caller's .git, which
  // repo tests (and the hermetic guard) treat as live lane access. Sibling of the caller so ../frontierui resolves.
  const isolate = isolated ? sha => {
    // No fallback to checkout bins: the admission wrapper's PATH ends with them, so a missing system tool
    // or non-executable system tool would silently resolve to a checkout-supplied replacement. Refuse up front instead.
    for (const tool of ['git', 'node', 'npm', 'sh']) {
      if (!systemPath.split(delimiter).some(d => {
        if (!d || approvedShimDir(d)) return false; // the shim stays on the child PATH (identity routing) but is never probed
        try {
          const candidate = join(d, tool);
          fs.accessSync(candidate, realFs.constants.X_OK);
          return fs.statSync(candidate).isFile();
        } catch { return false; }
      }))
        throw new Error(`required system tool "${tool}" not found on the system PATH; refusing to fall back to checkout node_modules/.bin`);
    }
    const parent = dirname(cwd);
    for (const name of fs.readdirSync(parent)) { // prune leftovers of dead runs
      const m = name.startsWith(worktreePrefix) && name.match(/-(\d+)$/);
      if (m && !pidAlive(Number(m[1]))) fs.rmSync(join(parent, name), { recursive: true, force: true });
    }
    const dir = join(parent, `${worktreePrefix}${sha.slice(0, 12)}-${process.pid}`);
    const stepHome = fs.mkdtempSync(join(tmpdir(), 'urgent-step-home-'));
    const resetCheckout = () => fs.rmSync(dir, { recursive: true, force: true });
    const cleanup = () => {
      for (const path of [stepHome, dir]) {
        try { fs.rmSync(path, { recursive: true, force: true }); }
        catch (e) { console.error(`urgent-verify: cleanup failed: ${e.message}`); }
      }
    };
    try {
      const origin = run('git', ['remote', 'get-url', 'origin']).trim();
      // The runner's own admission wrapper executes the isolated checkout's steps, so it must be committed code.
      if (String(run('git', ['status', '--porcelain', '--', 'scripts/readiness', 'scripts/lib'])).trim() !== '') throw new Error('runner admission wrapper has uncommitted changes; refusing to run it');
      const objects = join(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'objects');
      resetCheckout();
      run('git', ['init', '-q', dir]);
      run('git', ['remote', 'add', 'origin', origin], dir);
      fs.writeFileSync(join(dir, '.git/objects/info/alternates'), `${objects}\n`);
      run('git', ['checkout', '-q', '--detach', sha], dir);
      const scoped = createUrgentDeps({ cwd: dir, home, fs, spawnSync, env: { ...env, LANE_POOL_ROOT: admissionPool }, isolated: false, stepHome, wrapperRoot: cwd, deadline });
      if (scoped.head() !== sha) throw new Error('isolated checkout not at requested sha');
      return { deps: decorate ? decorate(scoped, dir) : scoped, cleanup };
    } catch (e) { cleanup(); throw e; }
  } : undefined;
  const self = { isolate, repo: () => normalizeUrgentRepo(run('git', ['remote', 'get-url', 'origin'])),
    readKey: () => {
      const path = urgentKeyPath(home);
      fs.mkdirSync(dirname(path), { recursive: true });
      try { fs.writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      return fs.readFileSync(path);
    }, host: hostname(), now: () => new Date().toISOString(),
    // Also refuse hidden changes: assume-unchanged (lowercase tag) and skip-worktree (S) entries make
    // `git status` lie, so a checkout could edit tracked files and still look clean.
    clean: () => run('git', ['status', '--porcelain']) === ''
      && !String(run('git', ['ls-files', '-v'])).split(/\r?\n/).some(l => /^[a-zS] /.test(l)),
    head: () => run('git', ['rev-parse', 'HEAD']).trim(),
    plan: () => {
      const workflow = fs.readFileSync(join(cwd, '.github/workflows/ci.yml'), 'utf8');
      gates = ciGatePlan(workflow);
      fs.rmSync(join(cwd, 'coverage-shards'), { recursive: true, force: true });
      return ciUnitPlan(workflow);
    },
    verifyFui: (expected) => {
      const rawRepo = normalizeUrgentRepo(run('git', ['remote', 'get-url', 'origin'], fui));
      const repo = canonicalFuiRepo(rawRepo);
      if (repo !== rawRepo) {
        // Old owner: prove GitHub really redirects it to the canonical repo before trusting it.
        const resolved = run('gh', ['repo', 'view', rawRepo.replace('https://github.com/', ''), '--json', 'url', '-q', '.url']).trim().toLowerCase();
        if (resolved !== urgentFuiRepo) throw new Error('FUI sibling origin must be frontier-ui/frontierui on github.com');
      }
      if (repo !== urgentFuiRepo) throw new Error('FUI sibling origin must be frontier-ui/frontierui on github.com');
      if (run('git', ['status', '--porcelain', '--untracked-files=all'], fui) !== '') throw new Error('FUI sibling must exist and be clean');
      if (expected) {
        const head = run('git', ['rev-parse', 'HEAD'], fui).trim();
        if (head !== expected.sha || repo !== expected.repo) throw new Error('FUI sibling changed');
        return { sha: head, repo };
      }
      run('git', ['fetch', 'origin'], fui);
      let tip;
      try { tip = run('git', ['rev-parse', '--verify', 'origin/HEAD^{commit}'], fui).trim(); }
      catch { tip = run('git', ['rev-parse', '--verify', 'origin/main^{commit}'], fui).trim(); }
      const head = run('git', ['rev-parse', 'HEAD'], fui).trim();
      if (!/^[a-f0-9]{40}$/i.test(head) || head !== tip) throw new Error('FUI sibling must match fetched origin default branch');
      return { sha: head, repo };
    },
    'fetch-main-history': () => run(gates.fetchMain[0], gates.fetchMain.slice(1)),
    'install-fui': () => { for (const command of gates.installFui) heavy(command, fui); },
    install: () => heavy(gates.install),
    shard: ({ group, shard }) => {
      let files = [];
      if (group) {
        files = run(process.execPath, ['scripts/ci/shard-assign.mjs', '--suite=unit', `--group=${group}`, `--shard=${shard}`]).trim().split(/\r?\n/);
        if (!files.length || files.some(f => !f || f.startsWith('-'))) throw new Error('empty or invalid CI assignment');
      }
      if (group === 'covered') fs.rmSync(join(cwd, 'coverage/coverage-final.json'), { force: true });
      // Derive the exact Vitest argv from CI's npm script; reject shell syntax or a changed admission wrapper.
      const script = group && JSON.parse(fs.readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.[group === 'covered' ? 'test:coverage:shard' : 'test:unit'];
      const command = group ? script?.match(/^node scripts\/readiness\/heavy-admission\.mjs run -- (vitest run(?: [\w:./=-]+)*)$/)?.[1]?.split(' ') : ['vitest', 'run'];
      if (!command) throw new Error('unreadable CI Vitest command; repair the runner or wait for CI');
      try {
        run(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=60000', '--require-admission', '--', 'vitest', 'run',
          ...command.slice(2), ...(group ? files : [`--shard=${shard}`])]);
      } catch (e) {
        // Hung-file report: assigned files that never printed a result line before the limit expired.
        if (e.failure?.timedOut && group) e.failure.hungFiles = files.filter(f => !String(e.stdout ?? '').split(/\r?\n/).some(l => /^\s*[✓✗×❯↓]/.test(l) && l.includes(f))).slice(0, 20);
        throw e;
      }
      if (group === 'covered') {
        const dest = join(cwd, 'coverage-shards', `coverage-shard-${shard.split('/')[0]}`);
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(join(cwd, 'coverage/coverage-final.json'), join(dest, 'coverage-final.json'));
      }
    },
    coverage: () => heavy(gates.coverage),
    hostPaths: () => heavy(gates.hostPaths),
    integration: () => {
      const skip = run(process.execPath, ['scripts/ci/quarantine-skip.mjs', '--job=integration']).trim();
      if (skip && !/^--exclude=(?:[\w./@-]+|\{[\w./@-]+(?:,[\w./@-]+)*\})$/.test(skip)) throw new Error('unreadable CI quarantine arguments');
      heavy([...gates.integration, '--', ...(skip ? [skip] : [])]);
    },
    standards: () => run(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=60000', '--require-admission', '--', 'npm', 'run', 'check:standards']),
    append: record => {
      const path = urgentLedger(home);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    // Signing state is off limits while checkout code runs. The key file and the ledger are locked (mode 000 / 400)
    // and fingerprinted; any change after a step means red. Restored by release() before the parent signs and appends.
    // Residual (same uid): a step could chmod the key back and read it; it cannot change it undetected.
    guardSigning: () => {
      const keyPath = urgentKeyPath(home), ledger = urgentLedger(home);
      const lock = [[keyPath, 0o000], [ledger, 0o400]];
      const snap = () => lock.map(([p]) => { try { const s = fs.statSync(p); return `${s.ino}:${s.mode}:${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } }).join('|');
      const release = () => { for (const [p] of lock) { try { fs.chmodSync(p, 0o600); } catch { /* absent */ } } };
      release(); // self-heal a lock left by a crashed run
      self.readKey(); // creates the key if absent, so it is always there to lock
      for (const [p, m] of lock) { try { fs.chmodSync(p, m); } catch { /* ledger may not exist yet */ } }
      const before = snap();
      return { release, check: () => { if (snap() !== before) throw new Error('signing state changed during a step'); } };
    },
  };
  return self;
}

export async function urgentVerify({ sha }, deps = createUrgentDeps({ isolated: true })) {
  const fallback = 'Use a clean checkout at the full SHA, repair CI layout/command or suite failures, and retry urgent-verify when capacity is available; alternatively wait for passing CI.';
  let iso, guard;
  try {
    if (typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha) && deps.isolate) { iso = deps.isolate(sha); deps = iso.deps; }
  } catch (e) { return { ok: false, detail: `isolated-worktree-failed: ${String(e.message)}`, fallback }; }
  const intact = () => { if (iso && (!deps.clean() || deps.head() !== sha)) throw new Error('checkout changed'); guard?.check(); };
  try {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha) || !deps.clean() || deps.head() !== sha)
      return { ok: false, detail: 'clean-checkout-at-sha-required', fallback };
    const plan = deps.plan(), startedAt = deps.now(), repo = deps.repo(), steps = [];
    if (!repo) throw new Error('unreadable origin remote');
    let result = 'green', fuiSha, fuiRepo, failure, currentStep = 'guard-signing';
    // Stop on failure, including queue exhaustion: no admission polling or retry loop.
    try {
      if (iso) guard = deps.guardSigning?.();
      currentStep = 'fetch-main-history'; steps.push(currentStep);
      await deps['fetch-main-history'](); intact();
      currentStep = 'verify-fui';
      const fui = await deps.verifyFui();
      fuiSha = fui.sha; fuiRepo = fui.repo;
      if (fuiRepo !== urgentFuiRepo) throw new Error('untrusted FUI origin');
      for (const step of ['install-fui', 'install']) { currentStep = step; steps.push(step); await deps[step](); intact(); }
      for (const shard of plan) { currentStep = `unit:${shard.group ?? 'unit'}:${shard.shard}`; steps.push(currentStep); await deps.shard(shard); intact(); }
      for (const step of ['coverage', 'hostPaths', 'integration', 'standards']) { currentStep = step; steps.push(step); await deps[step](); intact(); }
      currentStep = 'verify-checkout-final';
      if (!deps.clean() || deps.head() !== sha) throw new Error('checkout changed');
      currentStep = 'verify-fui-final';
      const finalFui = await deps.verifyFui({ sha: fuiSha, repo: fuiRepo });
      if (finalFui.sha !== fuiSha || finalFui.repo !== fuiRepo) throw new Error('FUI sibling changed');
    } catch (e) {
      result = 'red';
      failure = { step: currentStep, message: String(e?.message ?? e), ...(e?.failure ?? {}) };
      console.error(`urgent-verify RED at step ${failure.step}: ${failure.message}${failure.stderrTail ? `\n${failure.stderrTail}` : ''}`);
    }
    guard?.release(); // the parent alone reads the key and appends, after every step has finished
    const marker = { sha, suite: 'full', shards: plan.length, result, startedAt, finishedAt: deps.now(), host: deps.host, repo, steps, fuiSha, fuiRepo };
    marker.sig = urgentSignature(marker, deps.readKey());
    // failure detail is diagnostic only: outside the signed fields, so it cannot affect green verification.
    deps.append(failure ? { ...marker, failure } : marker);
    return { ok: result === 'green', marker, ...(failure ? { failure } : {}), ...(result === 'red' ? { fallback } : {}) };
  } catch (e) { return { ok: false, detail: String(e.message), fallback }; }
  finally { guard?.release(); iso?.cleanup(); }
}
