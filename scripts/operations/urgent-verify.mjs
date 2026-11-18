/** Full local CI test gate, sequential heavy admission, runner-authored receipts only. */
import { randomBytes } from 'node:crypto';
import * as realFs from 'node:fs';
import { spawnSync as realSpawn } from 'node:child_process';
import { hostname, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { ciUnitPlan, ciGatePlan, urgentLedger, urgentKeyPath, urgentSignature, normalizeUrgentRepo } from './urgent-verify-marker.mjs';

export function createUrgentDeps({ cwd = process.cwd(), home = homedir(), fs = realFs, spawnSync = realSpawn } = {}) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 4 * 60 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error('urgent-verify subprocess failed or admission unavailable; inspect output and retry after capacity is available');
    return r.stdout;
  };
  let gates;
  const heavy = args => run(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=60000', '--', ...args]);
  return { repo: () => normalizeUrgentRepo(run('git', ['remote', 'get-url', 'origin'])),
    readKey: () => {
      const path = urgentKeyPath(home);
      fs.mkdirSync(dirname(path), { recursive: true });
      try { fs.writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      return fs.readFileSync(path);
    }, host: hostname(), now: () => new Date().toISOString(),
    clean: () => run('git', ['status', '--porcelain']) === '',
    head: () => run('git', ['rev-parse', 'HEAD']).trim(),
    plan: () => {
      const workflow = fs.readFileSync(join(cwd, '.github/workflows/ci.yml'), 'utf8');
      gates = ciGatePlan(workflow);
      fs.rmSync(join(cwd, 'coverage-shards'), { recursive: true, force: true });
      return ciUnitPlan(workflow);
    },
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
      run(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=60000', '--', 'vitest', 'run',
        ...command.slice(2), ...(group ? files : [`--shard=${shard}`])]);
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
    standards: () => run(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=60000', '--', 'npm', 'run', 'check:standards']),
    append: record => {
      const path = urgentLedger(home);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
  };
}

export async function urgentVerify({ sha }, deps = createUrgentDeps()) {
  const fallback = 'Use a clean checkout at the full SHA, repair CI layout/command or suite failures, and retry urgent-verify when capacity is available; alternatively wait for passing CI.';
  try {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha) || !deps.clean() || deps.head() !== sha)
      return { ok: false, detail: 'clean-checkout-at-sha-required', fallback };
    const plan = deps.plan(), startedAt = deps.now(), repo = deps.repo(), key = deps.readKey(), steps = [];
    if (!repo) throw new Error('unreadable origin remote');
    let result = 'green';
    // Stop on failure, including queue exhaustion: no admission polling or retry loop.
    try {
      for (const shard of plan) { steps.push(`unit:${shard.group ?? 'unit'}:${shard.shard}`); await deps.shard(shard); }
      for (const step of ['coverage', 'hostPaths', 'integration', 'standards']) { steps.push(step); await deps[step](); }
      if (!deps.clean() || deps.head() !== sha) throw new Error('checkout changed');
    } catch { result = 'red'; }
    const marker = { sha, suite: 'full', shards: plan.length, result, startedAt, finishedAt: deps.now(), host: deps.host, repo, steps };
    marker.sig = urgentSignature(marker, key);
    deps.append(marker);
    return { ok: result === 'green', marker, ...(result === 'red' ? { fallback } : {}) };
  } catch (e) { return { ok: false, detail: String(e.message), fallback }; }
}
