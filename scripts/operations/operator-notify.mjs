/**
 * @file Push the operator's rule: "I only review human tag". Only NEEDS YOU notifies;
 * operator-queue owns readiness. Failure is never swallowed: swallowed stderr once
 * hid the drain daemon's fetch failure for 10 hours. All effects and time are injected.
 */
// A parked review that needs a ruling is notified once per PR AND head: a new head is a new ask.
export const itemKey = (row) => row.rulingHead
  ? `${row.repo}#${row.number}@${String(row.rulingHead).slice(0, 9)}:ruling` : `${row.repo}#${row.number}`;
export const rulingRows = (queue) => (Array.isArray(queue?.rulingNeeded) ? queue.rulingNeeded : [])
  .map((r) => ({ ...r, rulingHead: r.head, title: String(r.title ?? '') }));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizedState = (state) => ({ notified: Object.fromEntries(
  object(state?.notified) ? Object.entries(state.notified).filter(([, entry]) => object(entry) && typeof entry.title === 'string') : [],
) });
const errorText = (error) => String(error?.message ?? error);

/** Plan candidate successes; the runner removes candidates whose delivery fails. */
export function planNotifications({ ready, state, now }) {
  const previous = normalizedState(state).notified;
  const notified = {};
  const toNotify = [];
  for (const row of ready) {
    const key = itemKey(row);
    if (Object.hasOwn(notified, key)) continue;
    if (Object.hasOwn(previous, key)) notified[key] = previous[key];
    else {
      toNotify.push(row);
      notified[key] = { title: row.title, ...(now === undefined ? {} : { notifiedAt: now }) };
    }
  }
  return { toNotify, nextState: { notified } };
}

export const notificationFor = (row) => row.rulingHead
  ? { title: `Ruling needed: ${row.repo}#${row.number}`,
    body: `${row.findings.length} confirmed finding(s) wait on you: ${row.findings.map((f) => f.file ?? 'no file').join(', ')} — ${row.title}` }
  : { title: `Review needed: ${itemKey(row)}`, body: row.title };

export async function runOperatorNotify({ readQueue, readState, writeState, notify, now }) {
  let queue;
  try { queue = await readQueue(); }
  catch (error) { return { notified: [], failed: [], queueErrors: [errorText(error)], exitCode: 2 }; }
  const state = normalizedState(await readState());
  const { toNotify, nextState } = planNotifications({ ready: [...queue.ready, ...rulingRows(queue)], state, now });
  const queueErrors = queue.errors ?? [];
  if (queueErrors.length) nextState.notified = { ...state.notified, ...nextState.notified };
  const notified = [];
  const failed = [];
  for (const row of toNotify) {
    try {
      const result = await notify(notificationFor(row));
      if (result?.ok !== true) throw new Error(errorText(result?.error ?? 'Notifier did not confirm delivery'));
      notified.push(row);
    } catch (error) {
      delete nextState.notified[itemKey(row)];
      failed.push({ row, error: errorText(error) });
    }
  }
  const keys = Object.keys(state.notified);
  if (keys.length !== Object.keys(nextState.notified).length
    || keys.some((key) => !Object.hasOwn(nextState.notified, key)
      || JSON.stringify(state.notified[key]) !== JSON.stringify(nextState.notified[key]))) {
    await writeState(nextState);
  }
  return { notified, failed, queueErrors, exitCode: failed.length || queueErrors.length ? 1 : 0 };
}

if (process.argv[1] && /operator-notify\.mjs$/.test(process.argv[1])) {
  // Do not await this import at module scope: the CLI imports this core, so
  // awaiting would deadlock ESM evaluation when this file is the entry.
  import('./operator-notify-cli.mjs').then(async ({ main }) => {
    process.exitCode = await main(process.argv.slice(2));
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
