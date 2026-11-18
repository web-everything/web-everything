import { isQuotaError } from './provider-quota-hold.mjs';

// Deliberately narrower than the shared prefix matcher. Unknown reset formats remain
// quota failures, but require operator review rather than a quota-only exemption.
const RESET = /^(?:tomorrow|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} at (?:[1-9]|1[0-2])(?::[0-5]\d)?(?:am|pm) \([A-Za-z_]+(?:\/[A-Za-z_+-]+)+\)|(?:[1-9]|1[0-2])(?::[0-5]\d)?(?:am|pm)(?: \([A-Za-z_]+(?:\/[A-Za-z_+-]+)+\))?)(?![\s\S])/;

function wholeQuotaMessage(text) {
  const message = text.trim();
  if (!isQuotaError(message)) return false;
  return RESET.test(message.slice(message.indexOf(' · resets ') + ' · resets '.length));
}

/** Preserve evidence by presence, never by flattening/truthiness. No process proof means no exemption. */
export function acceptJurorStream(stdout, stderr = '', { code, signal, timedOut } = {}) {
  const entries = [];
  for (const [stream, text] of [['stdout', stdout], ['stderr', stderr]]) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { /* diagnostic text is evidence too */ }
      entries.push({ stream, line, event });
    }
  }
  const candidates = entries.flatMap(entry => {
    const event = entry.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || !(event.is_error === true || event.type === 'error')) return [];
    return ['error', 'message', 'result'].flatMap(key =>
      typeof event[key] === 'string' && isQuotaError(event[key]) ? [{ ...entry, key, text: event[key] }] : []);
  });
  if (!candidates.length) return null;
  const quota = candidates[0];
  const otherFailures = [];
  if (candidates.length !== 1 || entries.length !== 1) otherFailures.push('stream contains additional evidence');
  if (!wholeQuotaMessage(quota.text)) otherFailures.push('quota message is not a complete known shape');
  for (const key of ['error', 'errors', 'message', 'result', 'stderr', 'details']) {
    if (key !== quota.key && Object.hasOwn(quota.event, key)) otherFailures.push(`event contains ${key}`);
  }
  if (Object.hasOwn(quota.event, 'subtype') && !['error', 'success'].includes(quota.event.subtype)) {
    otherFailures.push('event contains another subtype');
  }
  if (code !== 0 || (signal !== null && signal !== undefined) || timedOut !== false) {
    otherFailures.push('process did not exit zero on its own without a signal');
  }
  return { text: quota.text, quotaOnly: otherFailures.length === 0, otherFailures };
}
