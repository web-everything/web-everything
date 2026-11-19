/** Pure S2 recommendations. No settings or enforced capacity are changed. */
const H = 3600000;
const finite = Number.isFinite;
const emptySummary = () => ({ merges: 0, medianTtmH: null, meanRounds: null, partial: 0 });

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
    if (!lower && s.partial > 0) return hold(`partial label timelines (${s.partial} PRs) block raises`);
    if (!lower && !s.capBinding && p.raiseOnlyIfBinding !== false) return hold('cap was not binding');
    const proposed = lower ? Math.round(cap * p.decrease * 10) / 10 : cap + p.increase;
    const to = Math.max(p.minUnits, Math.min(p.maxUnits, proposed));
    if (to === cap) return hold('at bound');
    return { action: lower ? 'lower' : 'raise', from, to, changed: true,
      reason: lower ? reasons.join(', ') : 'healthy delivery and binding policy satisfied' };
  } catch { return hold('tuning evidence unreadable'); }
}

/** Resource-only suggestion; missing evidence never permits an adjustment. */
export function resourceStep(input) {
  let from = null;
  const hold = reason => ({ action: 'hold', from, to: from, changed: false, reason });
  try {
    const { cap, signals: s, policy, last, nowMs } = input;
    from = finite(cap) ? cap : null;
    const p = policy.autoTune;
    if (last?.changed && nowMs - last.tsMs < p.everyMin * 60000) return hold('cooldown');
    if (['hold', 'pin'].includes(s?.override?.kind)) return hold('manual override active');
    if (s?.fallbackReason || s?.discoveryIncomplete === true) return hold('PR discovery incomplete');
    if (finite(cap) && cap < p.minUnits) return hold('configured cap below minUnits; not tuned');
    if (![s?.idlePct, s?.memGb, s?.heavyWaitMin, s?.lanesFree].every(finite)
      || !Array.isArray(s?.prs)
      || ('openCount' in s && !(finite(s.openCount) && s.prs.length >= s.openCount))
      || !s.prs.every(pr => pr && ['number', 'liveSessions', 'ciMin', 'heavyMin', 'rebases']
        .every(key => finite(pr[key]) && pr[key] >= 0) && typeof pr.laneHeld === 'boolean')) {
      // Fail closed in the safe direction: a readable low host reading still lowers; nothing here can raise.
      const low = [];
      if (finite(s?.idlePct) && finite(policy.idleMinPct) && s.idlePct < policy.idleMinPct) low.push('low idle');
      if (finite(s?.memGb) && finite(policy.memMinGb) && s.memGb < policy.memMinGb) low.push('low memory');
      if (low.length && [cap, p.decrease, p.minUnits, p.maxUnits].every(finite) && p.minUnits <= p.maxUnits) {
        const to = Math.max(p.minUnits, Math.min(p.maxUnits, Math.round(cap * p.decrease * 10) / 10));
        if (to < cap) return { action: 'lower', from, to, changed: true, reason: `${low.join(', ')} (resource evidence unreadable)` };
      }
      return hold('resource evidence unreadable');
    }
    if (![cap, nowMs, p.everyMin, p.increase, p.decrease, p.minUnits, p.maxUnits,
      p.heavyWaitMaxMin, p.lanesFreeMin, p.activeHighRatio, p.activeLowRatio,
      p.sessionUnits, p.minutesPerUnit, p.laneUnits, p.rebaseUnits,
      policy.idleMinPct, policy.memMinGb].every(finite)
      || p.minUnits > p.maxUnits || p.minutesPerUnit <= 0
      || p.activeLowRatio >= p.activeHighRatio) return hold('resource evidence unreadable');
    const activeUnits = s.prs.reduce((total, pr) => total + pr.liveSessions * p.sessionUnits
      + (pr.ciMin + pr.heavyMin) / p.minutesPerUnit
      + (pr.laneHeld ? p.laneUnits : 0) + pr.rebases * p.rebaseUnits, 0);
    if (!finite(activeUnits)) return hold('resource evidence unreadable');
    const reasons = [];
    if (s.idlePct < policy.idleMinPct) reasons.push('low idle');
    if (s.memGb < policy.memMinGb) reasons.push('low memory');
    if (s.heavyWaitMin > p.heavyWaitMaxMin) reasons.push('heavy wait');
    if (s.lanesFree < p.lanesFreeMin) reasons.push('few free lanes');
    if (activeUnits >= cap * p.activeHighRatio) reasons.push('high active units');
    const lower = reasons.length > 0;
    if (!lower && cap <= p.maxUnits) {
      if (activeUnits > cap * p.activeLowRatio) return hold('active units above raise threshold');
      if (!s.capBinding && p.raiseOnlyIfBinding !== false) return hold('cap was not binding');
    }
    const proposed = lower ? Math.round(cap * p.decrease * 10) / 10 : cap + p.increase;
    const to = Math.max(p.minUnits, Math.min(p.maxUnits, proposed));
    if (to === cap) return hold('at bound');
    return { action: to < cap ? 'lower' : 'raise', from, to, changed: true,
      reason: lower ? reasons.join(', ') : cap > p.maxUnits ? 'above maxUnits'
        : 'healthy resources and binding policy satisfied' };
  } catch { return hold('resource evidence unreadable'); }
}

export function summarizeMerged(prs, options) {
  try {
    const { holdLabels, nowMs, windowH } = options;
    if (!Array.isArray(prs) || !Array.isArray(holdLabels) || !finite(nowMs) || !finite(windowH)) return emptySummary();
    const times = [], rounds = [];
    let partial = 0;
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
      if (pr.partial === true) partial++;
      times.push(Math.max(0, end - start - heldMs) / H);
      rounds.push(count);
    }
    if (!times.length) return emptySummary();
    times.sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    return { merges: times.length, medianTtmH: times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2,
      meanRounds: rounds.reduce((a, b) => a + b, 0) / rounds.length, partial };
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
    // Holds are journaled too; they must not erase the last adjustment's cooldown.
    const lastChange = history.findLast(row => row?.changed === true);
    // `bindingNow` is this run's own observation; only it may feed later windows, or stale evidence renews itself.
    // Count mode compares PR count to openPrCap; it says nothing about the unit cap being tuned.
    const bindingNow = readout?.mode === 'units' && (readout?.verdict === 'deliver'
      || (finite(readout?.used) && finite(readout?.cap) && readout.used >= readout.cap));
    const binding = bindingNow
      || history.some(r => r?.bindingNow === true && finite(r.tsMs) && r.tsMs >= nowMs - p.windowH * H && r.tsMs <= nowMs);
    const host = typeof readout?.why?.[0] === 'string'
      ? /^gate (?:open|closed) \(idle (\d+(?:\.\d+)?)% mem (\d+(?:\.\d+)?)GB\)$/.exec(readout.why[0]) : null;
    const signals = { heavyWaitMin: input.resources?.heavyWaitMin ?? null, lanesFree: input.resources?.lanesFree ?? null,
      prs: input.resources?.prs ?? null, openCount: finite(readout?.openCount) ? readout.openCount : null, idlePct: host ? Number(host[1]) : null,
      memGb: host ? Number(host[2]) : null, capBinding: binding,
      override: readout?.override ?? null, fallbackReason: readout?.fallbackReason ?? null,
      discoveryIncomplete: readout?.discoveryIncomplete === true };
    const info = summarizeMerged(merged, { holdLabels: policy.holdLabels, nowMs, windowH: p.windowH });
    const row = { schema: 'deliveryCapacity.tune.v1', ts: new Date(nowMs).toISOString(), tsMs: nowMs,
      mode: p.mode, ...resourceStep({ cap, signals, policy, last: lastChange, nowMs }), binding, bindingNow, signals, info };
    return { row, line: renderTuneLine(row) };
  } catch { return null; }
}

export function renderTuneLine(row) {
  try {
    return `auto-tune (${row.mode}): would ${row.changed ? `set unitCap ${row.from}→${row.to}` : `hold unitCap ${row.from}`} because ${row.reason}`;
  } catch { return 'auto-tune (shadow): would hold unitCap null because tuning evidence unreadable'; }
}

/** True when `blob` names the PR: its `#N`/`pr-N` number, or its branch slug as a whole token (never a substring of a longer word). */
function namesPr(blob, pr) {
  const text = String(blob ?? '').toLowerCase();
  if (!text) return false;
  const slug = String(pr.headRefName ?? '').toLowerCase().replace(/^lane\//, '');
  const bounded = token => new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text);
  return (slug.length >= 4 && bounded(slug)) || bounded(`#${pr.number}`) || bounded(`pr-${pr.number}`);
}

/**
 * One row per open PR (explicit zeros included) from host-local sources, read once per tick by the caller.
 * Each source is `{ ok, ... }`; a source that is not `ok` is reported in `unreadable` and yields no rows
 * (an unreadable source must never count as zero). Pure: the shell does all IO.
 */
export function buildResourceRows({ openPrs, nowMs, sources }) {
  try {
    const { agents, heavy, leases, rebases } = sources ?? {};
    const unreadable = Object.entries({ agents, heavy, leases, rebases })
      .filter(([, s]) => s?.ok !== true).map(([name]) => name);
    if (unreadable.length) return { resources: null, unreadable };
    if (!Array.isArray(openPrs) || !finite(nowMs) || !Array.isArray(agents.rows) || !Array.isArray(heavy.records)
      || !Array.isArray(leases.leases) || !finite(leases.laneCount) || !Array.isArray(rebases.events)
      || !finite(heavy.waitMin) || heavy.waitMin < 0
      || !heavy.records.every(rec => rec && finite(Date.parse(rec.at)) && finite(rec.ms) && rec.ms >= 0)
      || !rebases.events.every(e => e && finite(e.tsMs) && Number.isInteger(e.number))
      || !openPrs.every(pr => Number.isInteger(pr?.number) && typeof pr.headRefName === 'string')) {
      return { resources: null, unreadable: ['shape'] };
    }
    const since = nowMs - H;
    const prs = openPrs.map(pr => {
      let ciMin = 0, heavyMin = 0;
      for (const rec of heavy.records) {
        const at = Date.parse(rec?.at);
        if (at < since || at > nowMs) continue;
        if (!namesPr(`${rec.session ?? ''} ${rec.command ?? ''}`, pr)) continue;
        if (rec.dispatchKind === 'ci-heal') ciMin += rec.ms / 60000; else heavyMin += rec.ms / 60000;
      }
      return { number: pr.number,
        liveSessions: agents.rows.filter(row => namesPr(
          `${row?.name ?? ''} ${row?.codexSlug ?? ''} ${row?.id ?? ''} ${row?.cwd ?? ''} ${row?.lease?.purpose ?? ''}`, pr)).length,
        ciMin, heavyMin,
        laneHeld: leases.leases.some(lease => namesPr(`${lease?.purpose ?? ''} ${lease?.session ?? ''}`, pr)),
        rebases: rebases.events.filter(e => e.number === pr.number && e.tsMs >= since && e.tsMs <= nowMs).length };
    });
    return { resources: { heavyWaitMin: heavy.waitMin, lanesFree: Math.max(0, leases.laneCount - leases.leases.length), prs } };
  } catch { return { resources: null, unreadable: ['shape'] }; }
}
