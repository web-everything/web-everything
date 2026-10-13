// Continuous-flow burndown for the backlog. NOT a sprint: scope grows as items
// are opened (dateOpened) and shrinks as they're resolved (dateResolved). We sum
// AGILE POINTS, not item counts — points live at exactly one level (see
// docs/agent/backlog-workflow.md → "Agile sizing"): a `story` carries its `size`,
// a `task` never does, a storied `epic` never does (its child stories carry it),
// an unstoried `epic` carries its own `size`. So summing every item's `size`
// counts each unit of scope exactly once — no double counting.
//
// Output (consumed by src/backlog.njk + assets/js/backlog-burndown.js):
//   { today, start, points:{total,done,remaining}, counts,
//     series:{ daily, weekly, monthly },        // each: [{date, scope, done, remaining}]
//     projection:{ daily },                      // [{date, remainingFrozen, remainingNet, scopeNet}]
//     rates, diverging, clearDateFrozen, clearDateNet }
const loadBacklog = require('./backlog.js');

const FIB = new Set([1, 2, 3, 5, 8, 13]);
const DAY = 86400000;
const toUTC = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ms, n) => ms + n * DAY;

module.exports = function burndown() {
  const all = loadBacklog();

  // Only items that carry points contribute to the burndown.
  const sized = all
    .filter((it) => it.status !== 'closed' && typeof it.size === 'number' && FIB.has(it.size))
    .map((it) => ({
      num: it.num,
      size: it.size,
      opened: it.dateOpened ? toUTC(it.dateOpened) : null,
      done: it.status === 'resolved' && it.dateResolved ? toUTC(it.dateResolved) : null,
    }))
    .filter((it) => it.opened != null);

  const counts = { story: 0, epic: 0, task: 0, decision: 0 };
  for (const it of all) if (it.kind) counts[it.kind] = (counts[it.kind] || 0) + 1;

  if (!sized.length) {
    return { empty: true, counts, points: { total: 0, done: 0, remaining: 0 } };
  }

  const sysToday = toUTC(fmt(Date.now()));
  const start = Math.min(...sized.map((it) => it.opened));
  const lastData = Math.max(...sized.map((it) => Math.max(it.opened, it.done || 0)));
  const today = Math.max(sysToday, lastData);

  // Daily cumulative series.
  const daily = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    let scope = 0, done = 0;
    for (const it of sized) {
      if (it.opened <= d) scope += it.size;
      if (it.done != null && it.done <= d) done += it.size;
    }
    daily.push({ date: fmt(d), scope, done, remaining: scope - done });
  }

  // Down-sample to period ends; always keep the final (today) point.
  const sample = (everyN) => {
    const out = [];
    for (let i = 0; i < daily.length; i++) {
      if (i % everyN === 0 || i === daily.length - 1) out.push(daily[i]);
    }
    return out;
  };
  const series = { daily, weekly: sample(7), monthly: sample(30) };

  const totalPts = sized.reduce((s, it) => s + it.size, 0);
  const donePts = sized.filter((it) => it.done != null).reduce((s, it) => s + it.size, 0);
  const remaining = totalPts - donePts;

  // Burn rates over a trailing window (smooths the heavy clustering of dates).
  const spanDays = Math.max(1, Math.round((today - start) / DAY));
  const W = Math.min(30, spanDays);
  const winStart = addDays(today, -W);
  const inWin = (t) => t != null && t > winStart && t <= today;
  const completionInWin = sized.filter((it) => inWin(it.done)).reduce((s, it) => s + it.size, 0);
  const intakeInWin = sized.filter((it) => inWin(it.opened)).reduce((s, it) => s + it.size, 0);
  const completionPerDay = completionInWin / W;
  const intakePerDay = intakeInWin / W;
  const netPerDay = completionPerDay - intakePerDay;

  const rates = {
    windowDays: W,
    completion: { day: completionPerDay, week: completionPerDay * 7, month: completionPerDay * 30 },
    intake: { day: intakePerDay, week: intakePerDay * 7, month: intakePerDay * 30 },
    net: { day: netPerDay, week: netPerDay * 7, month: netPerDay * 30 },
  };

  // Projection: extend remaining forward. "Frozen" = if intake stopped today
  // (pure burndown of current backlog). "Net" = if intake continues at the
  // trailing rate. Diverging ⇒ scope grows ≥ completion ⇒ no clear date.
  const diverging = netPerDay <= 0;
  const clearDateFrozen = completionPerDay > 0
    ? fmt(addDays(today, Math.ceil(remaining / completionPerDay))) : null;
  const clearDateNet = !diverging
    ? fmt(addDays(today, Math.ceil(remaining / netPerDay))) : null;

  const horizonDays = Math.min(365, clearDateFrozen
    ? Math.ceil(remaining / completionPerDay) + 7 : 90);
  const projDaily = [];
  const scopeNow = totalPts; // all currently-known scope is "opened" by today
  for (let k = 0; k <= horizonDays; k++) {
    const date = fmt(addDays(today, k));
    projDaily.push({
      date,
      remainingFrozen: Math.max(0, remaining - completionPerDay * k),
      remainingNet: Math.max(0, remaining - netPerDay * k),
      scopeNet: scopeNow + intakePerDay * k,
    });
  }

  return {
    empty: false,
    today: fmt(today),
    start: fmt(start),
    spanDays,
    counts,
    points: { total: totalPts, done: donePts, remaining },
    series,
    projection: { daily: projDaily },
    rates,
    diverging,
    clearDateFrozen,
    clearDateNet,
  };
};
