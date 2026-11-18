/** Single bounded pass over urgent loads; unreadable evidence requires operator attention. */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { removeRegistration } from '../daemon-overlay.mjs';
import { resolveOriginRepository } from './prototype-retire.mjs';
import { safeRegistrationRef, validSha, TEST_CHECK_APP_ID } from './prototype-load.mjs';
import { ciGatePlan, urgentLedger, normalizeUrgentRepo } from './urgent-verify-marker.mjs';
import { writeEscalationPacket } from './land-advance-escalations.mjs';

const identity = r => createHash('sha256').update(JSON.stringify([r.ref, r.sha, r.clone, r.registration])).digest('hex');
export function createSweepDeps({ home = homedir(), io = fs, exec = execFileSync, ghExec = execFileSyncThrottled, remove = removeRegistration, env = process.env } = {}) {
  const read = name => {
    const path = urgentLedger(home, name);
    try {
      if (io.statSync(path).size > 4 * 1024 * 1024) throw new Error('ledger exceeds 4 MiB; archive settled records and retry');
      return io.readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  const append = (name, record) => {
    const path = urgentLedger(home, name);
    io.mkdirSync(dirname(path), { recursive: true });
    io.appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
  return {
    loads: () => read('urgent-loads'), state: () => read('urgent-sweep-state'), now: () => new Date().toISOString(),
    required: r => ciGatePlan(String(exec('git', ['show', `${r.sha}:.github/workflows/ci.yml`],
      { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }))).requiredJobs,
    checks: r => {
      const git = args => ({ code: 0, stdout: String(exec('git', args, { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })) });
      if (normalizeUrgentRepo(git(['remote', 'get-url', 'origin']).stdout) !== r.repo) throw new Error('clone origin changed');
      const gh = args => ({ code: 0, stdout: String(ghExec('gh', args,
        { cwd: r.clone, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, throttle: { caller: 'urgent-sweep', exec: (a, o) => exec('gh', a, o) } })) });
      const origin = resolveOriginRepository({ git, gh });
      if (!origin.repo) throw new Error('unreadable CI repository');
      const result = origin.gh(['api', `repos/${origin.repo}/commits/${r.sha}/check-runs?per_page=100`]);
      if (result.code !== 0) throw new Error('unreadable CI checks');
      return JSON.parse(result.stdout);
    },
    remove: r => remove({ root: r.clone, ref: r.registration.ref, expectedTip: r.registration.sha,
      reason: `urgent-sweep: required CI failed for ${r.ref}@${r.sha}`, by: 'urgent-sweep', env }),
    event: r => append('urgent-loads', r), settle: r => append('urgent-sweep-state', r),
    escalate: packet => writeEscalationPacket(packet, { dir: join(home, 'workspace/.operations/escalations'), fs: io }),
  };
}

export async function urgentSweep(_input = {}, deps = createSweepDeps()) {
  const results = [], fallback = 'NEEDS-YOU: inspect urgent-loads and CI, repair unreadable evidence or unload the recorded overlay manually, then rerun urgent-sweep.';
  const escalate = (id, target, detail) => deps.escalate({ id: `urgent-${id}`, kind: 'needs-you', target,
    createdAt: deps.now(), status: 'open', evidence: [detail], question: fallback, ladder: { next: 'L3 operator' } });
  try {
    const settlements = deps.state();
    if (settlements.some(r => !/^[a-f0-9]{64}$/.test(r?.id ?? '') || !['settled-green', 'settled-unloaded', 'sweep-cursor'].includes(r.status)))
      throw new Error('unreadable urgent settlement ledger; repair it before sweeping');
    const settled = new Set(settlements.filter(r => r.status !== 'sweep-cursor').map(r => r.id));
    const loads = new Map(deps.loads().filter(r => r.type === 'prototype-load.urgent').map(r => [identity(r), r]));
    const entries = [...loads], cursor = settlements.filter(r => r.status === 'sweep-cursor').at(-1)?.id;
    // Use the complete load order so even a cursor load settled last pass remains an anchor.
    // Older ledgers (or an archived cursor load) start at the beginning.
    const start = entries.findIndex(([id]) => id === cursor) + 1;
    const batch = [...entries.slice(start), ...entries.slice(0, start)].filter(([id]) => !settled.has(id)).slice(0, 32);
    // Persist before readers/escalations: an unreadable or pending batch must not monopolize later ticks.
    if (batch.length) await deps.settle({ id: batch.at(-1)[0], status: 'sweep-cursor', at: deps.now() });
    // Two GitHub reads per load, at most 64 per tick. Remaining entries wait for the next orchestrator tick.
    for (const [id, r] of batch) {
      try {
        if (!validSha(r.sha) || !safeRegistrationRef(r.ref) || !isAbsolute(r.clone ?? '')
          || r.registration?.clone !== r.clone || !safeRegistrationRef(r.registration?.ref) || !validSha(r.registration?.sha))
          throw new Error('legacy or incomplete urgent registration; recover clone and ref manually');
        const required = await deps.required(r), data = await deps.checks(r);
        if (!Array.isArray(required) || !required.includes('test') || !Number.isInteger(data?.total_count)
          || data.total_count < 0 || data.total_count > 100 || !Array.isArray(data.check_runs)
          || data.check_runs.length !== data.total_count || data.check_runs.some(c => !Number.isSafeInteger(c?.id)
            || c.head_sha !== r.sha || typeof c.name !== 'string' || !Number.isSafeInteger(c.app?.id)
            || !['queued', 'in_progress', 'completed'].includes(c.status)
            || (c.status === 'completed' ? typeof c.conclusion !== 'string' : c.conclusion !== null)))
          throw new Error('unreadable, incomplete or oversized CI checks (maximum 100); repair reader or inspect CI manually');
        const checks = data.check_runs.filter(c => c.app.id === TEST_CHECK_APP_ID
          && required.some(n => c.name === n || c.name.startsWith(`${n} (`)));
        if (checks.some(c => c.status === 'completed' && ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(c.conclusion))) {
          const removal = await deps.remove(r);
          if (!removal || removal.refused || (removal.removed !== true && (!Array.isArray(removal.list) || removal.list.some(e => e.ref === r.registration.ref)))) throw new Error(`overlay removal refused: ${removal?.refused ?? 'unreadable result'}`);
          const event = { type: 'prototype-load.urgent-unloaded', at: deps.now(), id, ref: r.ref, sha: r.sha, clone: r.clone, registration: r.registration };
          await deps.event(event);
          await escalate(id, r.ref, `Unloaded ${r.sha}: required CI failed. Inspect and repair before reloading.`);
          await deps.settle({ ...event, status: 'settled-unloaded' });
          results.push({ id, status: 'settled-unloaded' });
        } else if (required.every(n => checks.some(c => c.name === n || c.name.startsWith(`${n} (`)))
          && checks.every(c => c.status === 'completed' && c.conclusion === 'success')) {
          await deps.settle({ id, ref: r.ref, sha: r.sha, at: deps.now(), status: 'settled-green' });
          results.push({ id, status: 'settled-green' });
        } else results.push({ id, status: 'pending' });
      } catch (e) {
        await escalate(id, r.ref, String(e.message));
        results.push({ id, status: 'needs-you', detail: String(e.message) });
      }
    }
    return { ok: results.every(r => r.status !== 'needs-you'), results, fallback };
  } catch (e) {
    await escalate('ledger', 'urgent-sweep', String(e.message));
    return { ok: false, detail: String(e.message), fallback };
  }
}
