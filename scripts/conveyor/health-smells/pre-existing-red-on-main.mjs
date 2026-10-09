/**
 * Perf item 42 — a lane's verify went red ONLY on tests that also fail on `origin/main`'s tip, outside the lane's
 * diff (`redCause: pre-existing-on-main`). The gate lets that push through (it is main's problem), so this smell is
 * what keeps main's red test from going quiet: one card per MAIN SHA (the subject is the base sha, so many lanes
 * hitting the same failure open one item, and a new main tip re-measures and can open a new one).
 */
export default {
  id: 'pre-existing-red-on-main',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['laneVerifyMarkers'],
  openAfter: 1,
  closeAfter: 2,
  // 'high' so the episode opens with a notify plan entry (`planActions` only notifies on high severity); the sign is on the
  // always-notify list (operator ruling 2026-10-09), so a red main alerts even in shadow mode and through quiet hours.
  severity: 'high',
  action: 'file',
  knownFix: {
    title: 'Tests failing on main @ ${subject}',
    digestTemplate: 'A lane verify went red only on tests that also fail on origin/main (${subject}), outside the lane diff, so the gate let '
      + 'the push through as pre-existing. Find the failing tests in the lane marker evidence (redCauseEvidence) and fix or quarantine them on main.',
    scope: ['we:scripts/verify-lane.mjs'],
    size: '2',
  },
  recommendationHint: 'A test fails on main itself; lanes are not blocked by it, so someone must fix main.',
  evaluate({ laneVerifyMarkers }) {
    const bySha = new Map();
    for (const m of laneVerifyMarkers || []) {
      if (m.status !== 'red' || m.redCause !== 'pre-existing-on-main' || !m.head || m.sha !== m.head) continue;
      const baseSha = m.redCauseEvidence?.baseSha;
      // A lane-written marker raises a quiet-hours-breaking alert, so the sha must look like one (and must not throw below).
      if (typeof baseSha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(baseSha)) continue;
      const entry = bySha.get(baseSha) ?? { tests: new Set(), lanes: [] };
      for (const t of m.redCauseEvidence.tests ?? []) entry.tests.add(t.name ? `${t.file} > ${t.name}` : t.file);
      entry.lanes.push(`${m.pool}/lane-${m.lane}`);
      bySha.set(baseSha, entry);
    }
    return [...bySha].map(([baseSha, { tests, lanes }]) => ({
      subject: `main:${baseSha.slice(0, 9)}`,
      breach: true,
      measure: { baseSha, tests: [...tests].slice(0, 20), lanes },
      summary: `main @ ${baseSha.slice(0, 9)}: ${tests.size} test(s) fail on main itself (seen via ${lanes.join(', ')}): ${[...tests].slice(0, 3).join('; ')}`,
      recommendation: 'Fix or quarantine the failing test(s) on main; lane gates treat them as pre-existing and no longer block pushes.',
    }));
  },
};
