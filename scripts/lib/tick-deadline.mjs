/**
 * A hard deadline for work that runs INSIDE the health-watch tick (the watchdog kills the whole tick at 180 s). The capped
 * prevention drain bounds when a card may START; this bounds how long any step of it may TAKE: every wait and subprocess
 * on the in-tick path gets `min(its own limit, time left)`, and a step the remaining time cannot cover is DEFERRED
 * (the card stays in the spool / stays owed) instead of started.
 */
export const TICK_BUDGET_CODE = 'TICK_BUDGET';

/** The whole in-tick drain (soft start budget + any started step) must be done by this much of tick time. */
export const DRAIN_HARD_DEADLINE_MS = 120_000;

/** Minimum time left for a step to be worth starting at all. */
export const STEP_MIN_MS = Object.freeze({
  exec: 1_000, pendingCard: 20_000, owedFiling: 45_000, dedupe: 10_000, fileItem: 30_000, admit: 15_000,
});

export const budgetError = what => Object.assign(new Error(`tick budget exhausted before ${what}`), { code: TICK_BUDGET_CODE });
export const isBudgetError = error => error?.code === TICK_BUDGET_CODE;

/** @returns {{at:number, now:()=>number, left:()=>number}} */
export const makeDeadline = (at, now = Date.now) => ({ at, now, left: () => at - now() });

/** Throws a budget error unless at least `minMs` is left. */
export function needTime(deadline, minMs, what) {
  if (deadline && deadline.left() < minMs) throw budgetError(what);
}

/** exec with every call capped at the time left; it will not start a call with less than {@link STEP_MIN_MS}.exec left. */
export const boundExec = (exec, deadline) => !deadline ? exec : (cmd, args, options = {}) => {
  const left = deadline.left();
  if (left < STEP_MIN_MS.exec) throw budgetError(`${cmd} ${args?.[0] ?? ''}`.trim());
  // SIGKILL: a child that ignores SIGTERM must not keep the call (and the tick) waiting past the cap.
  return exec(cmd, args, { ...options, timeout: Math.min(options.timeout ?? Infinity, left), killSignal: 'SIGKILL' });
};
