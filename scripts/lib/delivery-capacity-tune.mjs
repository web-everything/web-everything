/** Pure S2 recommendations. No settings or enforced capacity are changed. */
const H = 3600000;
const finite = Number.isFinite;
const emptySummary = () => ({ merges: 0, medianTtmH: null, meanRounds: null });

export function aimdStep(input) {
  let from = null;
  const hold = reason => ({ action: 'hold', from, to: from, changed: false, reason });
  try {
    const { cap, signals: s, policy, last, nowMs } = input;
    from = finite(cap) ? cap : null;
    const p = policy.autoTune;
    if (last?.changed && nowMs - last.tsMs < p.everyMin * 60000) return hold('cooldown');
    if (!finite(s?.idlePct) || !finite(s?.memGb)) return hold('host evidence unreadable');
    if (!finite(s.merges)) return hold('merge evidence unreadable');
    if (s.merges < p.minMerges) return hold(`too few merges (${s.merges} < ${p.minMerges})`);
    if (![cap, nowMs, s.medianTtmH, s.meanRounds, p.everyMin, p.minMerges, p.ttmTargetH,
      p.backoffFactor, p.roundsTarget, p.increase, p.decrease, p.minUnits, p.maxUnits,
      policy.idleMinPct, policy.memMinGb].every(finite)
      || p.minUnits > p.maxUnits) return hold('tuning evidence unreadable');
    const reasons = [];
    if (s.medianTtmH > p.ttmTargetH * p.backoffFactor) reasons.push('slow merges');
    if (s.meanRounds > p.roundsTarget + 1) reasons.push('many review rounds');
    if (s.idlePct < policy.idleMinPct) reasons.push('low idle');
    if (s.memGb < policy.memMinGb) reasons.push('low memory');
    const lower = reasons.length > 0;
    if (!lower && !s.capBinding && p.raiseOnlyIfBinding !== false) return hold('cap was not binding');
    const proposed = lower ? Math.round(cap * p.decrease * 10) / 10 : cap + p.increase;
    const to = Math.max(p.minUnits, Math.min(p.maxUnits, proposed));
    if (to === cap) return hold('at bound');
    return { action: lower ? 'lower' : 'raise', from, to, changed: true,
      reason: lower ? reasons.join(', ') : 'healthy delivery and binding policy satisfied' };
  } catch { return hold('tuning evidence unreadable'); }
}

export function summarizeMerged(prs, options) {
  try {
    const { holdLabels, nowMs, windowH } = options;
    if (!Array.isArray(prs) || !Array.isArray(holdLabels) || !finite(nowMs) || !finite(windowH)) return emptySummary();
    const times = [], rounds = [];
    for (const pr of prs) {
      const start = Date.parse(pr?.createdAt), end = Date.parse(pr?.mergedAt);
      if (!finite(start) || !finite(end) || end < start || end < nowMs - windowH * H || end > nowMs) continue;
      const events = (Array.isArray(pr.events) ? pr.events : []).map(e => ({
        at: Date.parse(e?.at), label: e?.label, type: e?.type,
      })).filter(e => finite(e.at) && e.at <= end).sort((a, b) => a.at - b.at);
      const active = new Set();
      let cursor = start, heldMs = 0, count = 1;
      for (const e of events) {
        if (e.type === 'labeled' && e.label === 'review:changes') count++;
        if (!holdLabels.includes(e.label)) continue;
        const at = Math.max(start, e.at);
        if (active.size) heldMs += at - cursor;
        cursor = at;
        if (e.type === 'labeled') active.add(e.label);
        if (e.type === 'unlabeled') active.delete(e.label);
      }
      if (active.size) heldMs += end - cursor;
      times.push(Math.max(0, end - start - heldMs) / H);
      rounds.push(count);
    }
    if (!times.length) return emptySummary();
    times.sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    return { merges: times.length, medianTtmH: times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2,
      meanRounds: rounds.reduce((a, b) => a + b, 0) / rounds.length };
  } catch { return emptySummary(); }
}

export function shadowTune(input) {
  try {
    const { readout, policy, merged, rows, nowMs } = input;
    const p = policy.autoTune;
    if (p.mode === 'off') return null;
    if (!['shadow', 'on'].includes(p.mode) || !finite(nowMs)) return null;
    const history = Array.isArray(rows) ? rows : [];
    const last = history.at(-1);
    const cap = last ? last.to : policy.unitCap;
    const binding = readout?.verdict === 'deliver'
      || (finite(readout?.used) && finite(readout?.cap) && readout.used >= readout.cap)
      || history.some(r => r?.binding === true && finite(r.tsMs) && r.tsMs >= nowMs - p.windowH * H && r.tsMs <= nowMs);
    const host = typeof readout?.why?.[0] === 'string'
      ? /^gate open \(idle (\d+(?:\.\d+)?)% mem (\d+(?:\.\d+)?)GB\)$/.exec(readout.why[0]) : null;
    const signals = { ...summarizeMerged(merged, { holdLabels: policy.holdLabels, nowMs, windowH: p.windowH }),
      idlePct: host ? Number(host[1]) : null, memGb: host ? Number(host[2]) : null, capBinding: binding };
    const row = { schema: 'deliveryCapacity.tune.v1', ts: new Date(nowMs).toISOString(), tsMs: nowMs,
      mode: p.mode, ...aimdStep({ cap, signals, policy, last, nowMs }), binding, signals };
    return { row, line: renderTuneLine(row) };
  } catch { return null; }
}

export function renderTuneLine(row) {
  try {
    return `auto-tune (${row.mode}): would ${row.changed ? `set unitCap ${row.from}→${row.to}` : `hold unitCap ${row.from}`} because ${row.reason}`;
  } catch { return 'auto-tune (shadow): would hold unitCap null because tuning evidence unreadable'; }
}
