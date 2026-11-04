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
  const context = { active: true, settings, timer, mainRuns: new Map(), fetches: new Map() };
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

/** Only `gh run list --branch main` is reused (once per repo per tick). `gh pr view` and the comments
 * totalCount are deliberately NOT cached (R549): fresh re-reads and completeness checks must see live data.
 */
export function memoReviewGh(args, opts, read) {
  const tick = ticks.getStore();
  if (!reviewTickMemoEnabled()) return read();
  if (!(args[0] === 'run' && args[1] === 'list' && flag(args, '--branch') === 'main')) return read();
  const repo = flag(args, '--repo') ?? flag(args, '-R') ?? opts.env?.GH_REPO ?? process.env.GH_REPO ?? '';
  const key = JSON.stringify([repo, args, opts.cwd ?? process.cwd(), opts.env ?? null, opts.encoding ?? null]);
  if (tick.mainRuns.has(key)) {
    const hit = tick.mainRuns.get(key);
    if ('error' in hit) throw hit.error;
    return hit.value;
  }
  try { const value = read(); tick.mainRuns.set(key, { value }); return value; }
  catch (error) { tick.mainRuns.set(key, { error }); throw error; }
}
