/** Urgent evidence permits prototype loading only; merging still requires real CI. */
import yaml from 'js-yaml';
import { createHmac, timingSafeEqual } from 'node:crypto';
export const urgentKeyPath = home => `${home}/workspace/.operations/state/urgent-verify.key`;
export const normalizeUrgentRepo = url => String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
export function urgentSignature(record, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('unreadable urgent key');
  const fields = ['sha', 'suite', 'shards', 'result', 'startedAt', 'finishedAt', 'host', 'repo', 'steps'];
  return createHmac('sha256', key).update(JSON.stringify(Object.fromEntries(fields.map(k => [k, record[k]])))).digest('hex');
}
export const urgentLedger = (home, name = 'urgent-full-green') => `${home}/workspace/.operations/coordination/${name}.jsonl`;
export const urgentReason = (reason) => typeof reason === 'string' && reason.trim().length >= 10;
const fullSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);

/** Fail closed on an unknown CI layout. No shell workflow text is executed. */
export function ciUnitPlan(workflow) {
  const job = yaml.safeLoad(workflow)?.jobs?.['test-shard'];
  const matrix = job?.strategy?.matrix;
  const shards = matrix?.shard;
  if (!Array.isArray(shards) || !shards.length || shards.length > 64
    || Object.keys(matrix).length !== 1 || shards.some((v, i) => v !== i + 1)) throw new Error('unreadable-ci-shards');
  const steps = job.steps.filter(s => typeof s.run === 'string');
  const groups = steps.filter(s => s.run.includes('scripts/ci/shard-assign.mjs --suite=unit'));
  if (groups.length === 2) {
    const covered = groups.find(s => s.run.includes('--group=covered'));
    const nocov = groups.find(s => s.run.includes('--group=nocov --shard=1/1'));
    const divisor = Number(covered?.run.match(/--shard=\$\{\{ matrix.shard \}\}\/(\d+)/)?.[1]);
    if (divisor !== shards.length - 1 || !covered?.run.includes('npm run test:coverage:shard --')
      || !nocov?.run.includes('npm run test:unit --')
      || !covered.if?.includes(`matrix.shard != ${shards.length}`)
      || !nocov.if?.includes(`matrix.shard == ${shards.length}`)) throw new Error('unreadable-ci-shards');
    return shards.map(i => ({ group: i === shards.length ? 'nocov' : 'covered', shard: i === shards.length ? '1/1' : `${i}/${divisor}` }));
  }
  if (groups.length || !steps.some(s => /vitest run --shard=\$\{\{ matrix.shard \}\}\/\$\{\{ strategy.job-total \}\}/.test(s.run))) throw new Error('unreadable-ci-shards');
  return shards.map(i => ({ shard: `${i}/${shards.length}` }));
}

/** Mirror only the known CI command and artifact layout; changes require an operator update. */
export function ciGatePlan(workflow) {
  const jobs = yaml.safeLoad(workflow)?.jobs, plan = ciUnitPlan(workflow);
  const covered = plan.filter(s => s.group === 'covered').length;
  const step = (job, name) => {
    const matches = jobs?.[job]?.steps?.filter(s => s.name === name);
    if (matches?.length !== 1) throw new Error('unreadable-ci-gates');
    return matches[0];
  };
  const merge = step('coverage-merge', 'Merge coverage + enforce 80% bar (#2082)').run;
  const host = step('host-paths', 'Host-local path ratchet').run;
  const integration = step('integration', 'Real-git integration suite (lane-pool, operations transport)').run;
  const upload = step('test-shard', 'Upload shard coverage');
  const download = step('coverage-merge', 'Download shard coverage');
  if (!covered || merge !== `npm run coverage:merge -- coverage-shards --threshold=80 --expect=${covered}`
    || host !== 'node scripts/lint-host-paths.mjs'
    || integration !== 'npm run test:integration:vitest -- $(node scripts/ci/quarantine-skip.mjs --job="integration")'
    || upload.uses !== 'actions/upload-artifact@v4' || upload.with?.name !== 'coverage-shard-${{ matrix.shard }}'
    || upload.with?.path !== 'web-everything/coverage/coverage-final.json' || upload.with?.['if-no-files-found'] !== 'error'
    || !upload.if?.includes(`matrix.shard != ${plan.length}`)
    || download.uses !== 'actions/download-artifact@v4' || download.with?.path !== 'web-everything/coverage-shards'
    || download.with?.pattern !== 'coverage-shard-*' || download.with?.['merge-multiple'] === true) throw new Error('unreadable-ci-gates');
  return { coverage: merge.split(' '), hostPaths: host.split(' '), integration: integration.split(' -- $(')[0].split(' ') };
}

export function urgentMarker({ urgent, reason, sha, ledger, shards, expectedSteps, now, repo, readKey }) {
  const no = (detail) => ({ ok: false, detail, fallback: `Run node scripts/operations/run.mjs urgent-verify --sha=${sha} in a clean checkout, then retry with --urgent --reason=<at least 10 characters>; or wait for passing CI.` });
  if (urgent !== true || !urgentReason(reason) || !fullSha(sha)) return no('no-urgent-marker');
  try {
    const records = ledger.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    const marker = records.filter(r => r?.sha === sha).at(-1);
    const finished = typeof marker?.finishedAt === 'string' ? Date.parse(marker.finishedAt) : NaN;
    const started = typeof marker?.startedAt === 'string' ? Date.parse(marker.startedAt) : NaN;
    if (!Number.isInteger(shards) || shards < 1 || !marker || marker.suite !== 'full' || marker.result !== 'green'
      || marker.shards !== shards || !Number.isFinite(now) || !Number.isFinite(finished) || !(started < finished)
      || now - finished > 2 * 60 * 60_000 || finished - now > 5 * 60_000
      || typeof marker.host !== 'string' || !marker.host.trim()) return no('no-urgent-marker');
    if (!repo || marker.repo !== repo || !Array.isArray(marker.steps)
      || !Array.isArray(expectedSteps) || expectedSteps.length !== shards + 4
      || marker.steps.length !== expectedSteps.length || !expectedSteps.every((step, i) => marker.steps[i] === step)
      || !/^[a-f0-9]{64}$/.test(marker.sig ?? '')
      || !timingSafeEqual(Buffer.from(marker.sig, 'hex'), Buffer.from(urgentSignature(marker, readKey()), 'hex'))) return no('no-urgent-marker');
    return { ok: true, evidence: { source: 'urgent-local-full', marker, reason } };
  } catch { return no('no-urgent-marker'); }
}
