/** Same-pass negative evidence only. Missing/changed evidence always requires normal admission. */
const kinds = new Set(['sent-back', 'mq-same-head-failed', 'ready-not-reached']);
function labelsKey(labels) {
  if (!Array.isArray(labels)) return null;
  const names = labels.map(label => typeof label === 'string' ? label : label?.name);
  if (names.some(name => typeof name !== 'string' || !name.trim())) return null;
  return JSON.stringify([...new Set(names)].sort());
}
export function shouldSkipCascade(previous, current) {
  if (!kinds.has(previous?.kind) || !previous?.headSha || !current?.headSha) return false;
  if (previous.pass == null || previous.pass !== current.pass) return false;
  const labels = labelsKey(previous.labels);
  return previous.headSha === current.headSha && labels !== null && labels === labelsKey(current.labels);
}
