/** Pure planning and findings rendering for the review daemon's mechanical send-back. */
const labels = pr => Array.isArray(pr?.labels) ? pr.labels.map(l => typeof l === 'string' ? l : l?.name) : [];
export const pendingOnly = pr => labels(pr).includes('review:pending')
  && !labels(pr).some(l => ['review:changes', 'review:human'].includes(l));
export const headKey = (repo, pr) => `${repo}#${pr.number}@${pr.headRefOid}`;
export const validHead = pr => /^[a-f0-9]{40}$/i.test(pr?.headRefOid ?? '');

export function planSendBacks({ plan, prs, sentLedger = {} }) {
  return (plan?.dispatch ?? []).flatMap(entry => {
    if (entry.kind !== 'fix' || entry.mode !== 'block-ruled-referral') return [];
    const pr = prs?.find(p => Number(p.number) === Number(entry.prNumber));
    const repo = entry.repo ?? plan.repo;
    if (!repo || !validHead(pr) || !pendingOnly(pr) || sentLedger[headKey(repo, pr)]) return [];
    return [{ repo, prNumber: pr.number, headSha: pr.headRefOid, key: headKey(repo, pr),
      body: renderFindingsBody(entry.blockRuledReferrals) }];
  });
}

const clean = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
const normal = text => clean(text).toLowerCase().replace(/[.!?;:,\s]+$/u, '');
export function renderFindingsBody(referrals = []) {
  const groups = [];
  for (const ref of referrals) {
    const f = ref?.finding;
    if (!clean(f?.summary)) throw new Error('blocking referral has no findings text; operator attention required');
    let seat = ref.seat;
    try { seat ??= JSON.parse(ref.key)[0]; } catch { /* legacy key: retain unknown seat */ }
    const text = `${clean(f.file)}|${normal(f.summary)}`;
    const location = f.file && Number.isInteger(f.line) ? `${f.file}:${f.line}` : null;
    const matches = groups.filter(g => g.texts.has(text));
    const group = matches.shift() ?? { finding: f, texts: new Set(), locations: new Set(), seats: new Set() };
    if (!groups.includes(group)) groups.push(group);
    for (const other of matches) {
      for (const field of ['texts', 'locations', 'seats']) for (const v of other[field]) group[field].add(v);
      groups.splice(groups.indexOf(other), 1);
    }
    group.texts.add(text);
    if (location) group.locations.add(location);
    group.seats.add(clean(seat) || 'unknown');
  }
  if (!groups.length) throw new Error('no blocking findings; operator attention required');
  return 'Blocking referrals ruled block on this head:\n\n' + groups.map(g => {
    const f = g.finding;
    const at = [...g.locations].sort().map(l => `\`${clean(l)}\``).join(', ') || (f.file ? `\`${clean(f.file)}\`` : '');
    return `- ${at ? `${at} — ` : ''}${clean(f.summary)} (seats: ${[...g.seats].sort().join(', ')})`;
  }).join('\n');
}
