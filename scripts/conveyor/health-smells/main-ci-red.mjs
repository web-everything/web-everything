/**
 * Card xu1nixv — main's own CI workflow stays red past the threshold (`mainCiRedThresholdMs`, default 15 min).
 * Reads the `mainCiRuns` probe (we:scripts/conveyor/main-ci-red-io.mjs#probeMainCiRuns — `gh run list --workflow
 * ci.yml --branch main`, plus the failing jobs/tests and the owner decision made this tick). One episode per broken
 * commit: the subject is the FIRST red commit, so every later red push in the same window stays one episode, and a
 * new break after a green run opens a new one. An unreadable read never reaches here (the probe errors, the smell is
 * skipped, its episode does not move). 2026-10-08: main was red 17:04Z → past 22:35Z with no alert and no owner.
 *
 * High severity + listed in `NOTIFY_EVEN_IN_SHADOW`, so it alerts even while the health watch runs in shadow. Its
 * alert title (`Health: main-ci-red — main:<sha>`) is a main-red alert to the quiet-hours gate, so it breaks
 * through quiet hours.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mainCiRedSettings, mainRedState, isRedLongEnough, MINUTE } from '../main-ci-red-core.mjs';
import { runSafetyNet } from '../../lib/red-main-quarantine-io.mjs';
import { healthDir } from '../health-watch-section.mjs';
import { isUnderTest } from '../../lib/under-test.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Card xx7ckd6 N1 — the red-main QUARANTINE safety net rides on this smell's tick: it adds main's known failing test
 * files to `ops/quarantine` and prunes them on green or at expiry (we:scripts/lib/red-main-quarantine-io.mjs
 * `runSafetyNet`). It acts LIVE only when `redMainMode` is `quarantine`; otherwise (the default `stop`) it logs what
 * it WOULD do to `<health dir>/red-main-quarantine-shadow.jsonl` — evidence for the red-team review. A replay / dry-run
 * tick (`--main-ci-runs-fixture`, `--dry-run`, `--lock-root`, `--state-root`) is always shadow, and nothing runs under
 * test unless a test passes its own `ctx.quarantineSafetyNet`. It never changes what the smell reports.
 */
const REPLAY_FLAGS = ['--main-ci-runs-fixture', '--dry-run', '--lock-root', '--state-root'];
export function defaultQuarantineSafetyNet(mainCiRuns, { now, argv = process.argv } = {}) {
  if (isUnderTest()) return null;
  const replay = (argv ?? []).some((a) => REPLAY_FLAGS.some((f) => a === f || String(a).startsWith(`${f}=`)));
  return runSafetyNet({ mainCiRuns, now, dir: healthDir(), board: REPO_ROOT, live: !replay });
}

const fmtMin = (ms) => `${Math.round(ms / MINUTE)} min`;

export default {
  id: 'main-ci-red',
  scope: 'repo',
  cadence: 'every-tick',
  probes: ['mainCiRuns'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  recommendationHint: "Main's CI is red; one owner is dispatched per broken commit unless an open PR already fixes it.",
  evaluate({ mainCiRuns }, { now, config, quarantineSafetyNet = defaultQuarantineSafetyNet }) {
    const settings = mainCiRedSettings(config);
    const state = mainRedState(mainCiRuns?.runs);
    let quarantine = null;
    try { quarantine = quarantineSafetyNet ? quarantineSafetyNet(mainCiRuns, { now }) : null; } catch { quarantine = null; }
    if (state.status !== 'red') return [];
    const sha9 = state.firstRed.sha.slice(0, 9);
    const redFor = now - state.redSinceMs;
    const failing = mainCiRuns?.failing || {};
    const owner = mainCiRuns?.owner ?? null;
    const decision = mainCiRuns?.decision ?? null;
    const ownerText = owner ? `owner: ${owner.kind} ${owner.ref}` : `owner: none (${decision?.reason ?? 'not decided'}${decision?.why ? ` — ${decision.why}` : ''})`;
    return [{
      subject: `main:${sha9}`,
      breach: settings.mainCiRedEnabled && isRedLongEnough(state, { now, thresholdMs: settings.mainCiRedThresholdMs }),
      measure: {
        firstRedSha: state.firstRed.sha, firstRedAt: state.firstRed.createdAt, lastGreenSha: state.lastGreen?.sha ?? null,
        latestRedSha: state.latestRed.sha, redForMin: Math.round(redFor / MINUTE), windowTruncated: state.windowTruncated,
        failingJobs: (failing.jobs || []).slice(0, 10), failingTests: (failing.tests || []).slice(0, 5),
        owner, ownerDecision: decision?.reason ?? null, dispatched: mainCiRuns?.dispatched ?? null,
        priorityPr: mainCiRuns?.priority?.pr ?? null,
        quarantine: quarantine ? { mode: quarantine.mode, shadow: quarantine.shadow, action: quarantine.plan?.action ?? null, tests: quarantine.plan?.tests ?? [], why: quarantine.plan?.why ?? null, ...(quarantine.error ? { error: quarantine.error } : {}) } : null,
      },
      summary: `main CI red for ${fmtMin(redFor)} since ${sha9} (last green ${state.lastGreen?.sha.slice(0, 9) ?? 'unknown'}); failing: ${(failing.jobs || []).join(', ') || 'unknown'}; ${ownerText}${mainCiRuns?.priority ? `; PR #${mainCiRuns.priority.pr} has queue priority` : ''}.`,
      recommendation: owner
        ? `Main is red since ${sha9}; ${owner.kind} ${owner.ref} owns the fix. Watch it land; do not fix main by hand.`
        : `Main is red since ${sha9} and has no owner (${decision?.reason ?? 'not decided'}). The main-red owner dispatch (main-ci-red-io.mjs) should send one; check why it did not.`,
    }];
  },
};
