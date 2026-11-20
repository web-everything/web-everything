/** Drain serial steps synchronously until a step yields a promise, then await it before resuming.
 * Existing mechanical-pass callers keep their synchronous API; the fix daemon supplies an async boundary.
 * No work is queued or run concurrently. Rejections are thrown back into the owning step's try/catch.
 */
export function runCooperativeSteps(steps) {
  function advance(value, failed = false) {
    let step = failed ? steps.throw(value) : steps.next(value);
    while (!step.done) {
      if (step.value && typeof step.value.then === 'function') {
        return Promise.resolve(step.value).then(value => advance(value), error => advance(error, true));
      }
      step = steps.next(step.value);
    }
    return step.value;
  }
  return advance();
}
