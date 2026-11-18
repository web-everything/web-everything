/** Urgent evidence permits prototype loading only; merging still requires real CI. */
import yaml from 'js-yaml';
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

export function urgentMarker({ urgent, reason, sha, ledger, shards, now }) {
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
    return { ok: true, evidence: { source: 'urgent-local-full', marker, reason } };
  } catch { return no('no-urgent-marker'); }
}
