/** Durable, synchronous carry publication. Remote postconditions, not journal flags, decide retries. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sharedRunsDir } from '../operations/run-store.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';

const steps = ['intent', 'label', 'comment', 'done'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
function identity({ repo, pr, head, kind = 'card-only' }) {
  if (typeof repo !== 'string' || !repo || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0
    || !sha(head) || kind !== 'card-only') throw Error('invalid carry identity; inspect stored evidence before retrying');
  return { repo, pr: Number(pr), head, kind };
}
function carryPath(key, env) {
  const hash = createHash('sha256').update(JSON.stringify(identity(key))).digest('hex');
  return join(dirname(sharedRunsDir(env)), 'red-team-status', 'carry', `${hash}.json`);
}

export function readRedTeamCarry({ env = process.env, ...key }) {
  try {
    const state = JSON.parse(readFileSync(carryPath(key, env), 'utf8'));
    if (state?.version !== 1 || !steps.includes(state.step)
      || JSON.stringify(identity(state)) !== JSON.stringify(identity(key))
      || state.loopPayload?.verdict !== null || !sha(state.loopPayload?.carriedFrom)
      || state.loopPayload?.findings?.read?.netBasis?.rev !== state.head) {
      throw Error('invalid carry journal; inspect stored evidence before retrying');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error('carry journal unreadable; inspect stored evidence before retrying', { cause: error });
  }
}

/** IO is synchronous like review-job. The shared lock is crash-reclaimable and never steals a live owner.
 * A lock timeout is retryable, not permission to publish concurrently. No model IO belongs here.
 */
export function resumeRedTeamCarry(input, io) {
  const key = identity(input), env = io.env ?? process.env, path = carryPath(key, env);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(`${path}.lock`, () => {
    let state = readRedTeamCarry({ ...key, env });
    if (state?.step === 'done') return { outcome: 'already' };
    if (!state) {
      const payload = input.loopPayload;
      if (!sha(payload?.carriedFrom) || payload?.findings?.read?.netBasis?.rev !== key.head) {
        throw Error('invalid carry payload; inspect stored evidence before retrying');
      }
      state = { ...key, version: 1, step: 'intent', loopPayload: { ...payload, verdict: null } };
    }
    const guard = () => {
      if (io.eligible(state) !== true) throw Error('carry refused: policy, hold, head or review evidence changed; inspect before retrying');
    };
    const record = step => {
      state = { ...state, step: steps[Math.max(steps.indexOf(state.step), steps.indexOf(step))] };
      writeJsonAtomic(path, state);
    };
    guard();
    if (state.reviewWitness === undefined && io.witness) state = { ...state, reviewWitness: io.witness() };
    // Record intent before ANY external effect, including the compatibility status projection.
    if (!readRedTeamCarry({ ...key, env })) record('intent');
    for (const [step, check, act] of [
      ['intent', 'intentRecorded', 'recordIntent'],
      ['label', 'labelApplied', 'applyLabel'],
      ['comment', 'resultVisible', 'postResult'],
    ]) {
      guard();
      const satisfied = io[check](state);
      if (satisfied !== true && satisfied !== false) throw Error(`carry ${step} evidence unreadable; inspect before retrying`);
      if (!satisfied) {
        io[act](state);
        if (io[check](state) !== true) throw Error(`carry ${step} not observed; retry after inspecting remote evidence`);
      }
      record(step);
      io.checkpoint?.(`after-${step}`, state);
    }
    io.checkpoint?.('before-done', state);
    guard();
    record('done');
    return { outcome: 'policy-clear' };
  });
}
