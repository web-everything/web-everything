/** Tick-local review read reuse. No context means the existing live IO path. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { createStepTimer, formatTimingsSummary } from './pass-timings.mjs';

const ticks = new AsyncLocalStorage();
const STEPS = ['setup', 'list', 'ledger-read', 'per-PR-loop', 'human-surface', 'free-scope', 'label-provider'];
const onOff = value => value === 'on' || value === 'off';
export function resolveReviewTickSettings({ env = process.env, read = readSettings, platform, log } = {}) {
  const layer = review => ({ tick: { memoize: review?.tick?.memoize, stepTimings: review?.tick?.stepTimings } });
  return cascadePolicy('review', layer(read()?.review), {
    standard: { tick: { memoize: 'off', stepTimings: 'off' } },
    platform: layer(platform ?? platformPreference('review', { env })), env, log, valid: onOff,
  });
}

/** One fresh context for the whole daemon pass, including every repo and awaited stage. */
export function withReviewTick(fn, { settings = resolveReviewTickSettings().value.tick,
  log = line => console.error(line), now = Date.now } = {}) {
  const timer = createStepTimer(now), started = now();
  const context = { active: true, settings, timer, reads: new Map(), mainRuns: new Map(), heads: new Map(), fetches: new Map() };
  const finish = () => {
    context.active = false;
    if (settings.stepTimings === 'on') log(`review-daemon · pass timings: ${formatTimingsSummary(
      { ...Object.fromEntries(STEPS.map(key => [key, 0])), ...timer.snapshot() }, { total: now() - started, order: STEPS })}`);
  };
  return ticks.run(context, () => {
    let result;
    try { result = fn(); } catch (error) { finish(); throw error; }
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(finish);
    finish();
    return result;
  });
}
export function timeReviewStep(label, fn) {
  const tick = ticks.getStore();
  return tick?.active && tick.settings.stepTimings === 'on' ? tick.timer.time(label, fn) : fn();
}
export function addReviewStep(label, ms) {
  const tick = ticks.getStore();
  if (tick?.active && tick.settings.stepTimings === 'on') tick.timer.add(label, ms);
}
export const reviewTickMemoEnabled = () => {
  const tick = ticks.getStore();
  return tick?.active && tick.settings.memoize === 'on';
};

/** Cache failures as failures too: no second fetch or stale-base fallback until next tick. */
export function fetchReviewMainOnce(key, fetch) {
  const tick = ticks.getStore();
  if (!reviewTickMemoEnabled()) return fetch();
  if (!tick.fetches.has(key)) {
    try { tick.fetches.set(key, { value: fetch() }); }
    catch (error) { tick.fetches.set(key, { error }); }
  }
  const hit = tick.fetches.get(key);
  if ('error' in hit) throw hit.error;
  return hit.value;
}

const flag = (args, name) => {
  const equal = args.find(a => a.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

/** Only these expensive reads are reused. Live head-only probes still detect pushes mid-pass.
 * Full argv and checkout scope stay in the key, so field sets, repos and auth routes cannot alias.
 * Writes invalidate all GitHub evidence, including counts, before executing (even a failed write may land).
 */
export function memoReviewGh(args, opts, read) {
  const tick = ticks.getStore();
  if (!reviewTickMemoEnabled()) return read();
  const [command, operation] = args;
  const graphqlCount = command === 'api' && operation === 'graphql'
    && args.some(a => a.includes('comments{totalCount}'));
  const mutation = (command === 'pr' && ['edit', 'comment', 'review', 'merge', 'close', 'reopen', 'ready', 'create'].includes(operation))
    || (command === 'api' && !graphqlCount && (operation === 'graphql' || args.includes('--input')
      || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(flag(args, '--method') ?? flag(args, '-X'))));
  if (mutation) { tick.reads.clear(); return read(); }
  const repo = flag(args, '--repo') ?? flag(args, '-R') ?? opts.env?.GH_REPO ?? process.env.GH_REPO ?? '';
  const scope = JSON.stringify([repo, opts.cwd ?? process.cwd(), opts.env ?? null, opts.encoding ?? null]);
  let identity = null, liveHead = false;
  if (command === 'pr' && operation === 'view' && /^\d+$/.test(args[2] ?? '')) {
    identity = `${scope}:${args[2]}`;
    const fields = flag(args, '--json');
    liveHead = !!fields?.split(',').includes('headRefOid')
      && fields.split(',').every(field => ['headRefOid', 'labels'].includes(field));
    if (!fields) return read();
  } else if (graphqlCount) {
    const field = name => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
    const slug = `${field('owner')}/${field('name')}`;
    const countScope = JSON.stringify([slug, opts.cwd ?? process.cwd(), opts.env ?? null, opts.encoding ?? null]);
    identity = `${countScope}:${field('n')}`;
    // Without a pinned head a count is not reusable evidence.
    if (!tick.heads.has(identity)) return read();
  } else if (!(command === 'run' && operation === 'list' && flag(args, '--branch') === 'main')) return read();
  const keyFor = () => JSON.stringify([scope, args, identity ? tick.heads.get(identity) ?? null : null]);
  const cache = identity ? tick.reads : tick.mainRuns;
  const key = keyFor();
  if (!liveHead && cache.has(key)) {
    const hit = cache.get(key);
    if ('error' in hit) throw hit.error;
    return hit.value;
  }
  let value;
  try { value = read(); }
  catch (error) { if (!liveHead) cache.set(key, { error }); throw error; }
  if (identity && command === 'pr') {
    try {
      const head = JSON.parse(String(value))?.headRefOid;
      if (typeof head === 'string' && head) tick.heads.set(identity, head);
      else if (!tick.heads.has(identity)) return value;
    } catch { return value; }
  }
  if (!liveHead) cache.set(keyFor(), { value });
  return value;
}
