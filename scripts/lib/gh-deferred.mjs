/** Non-error throttle result shared by pass readers without importing the gh runner. */
export function isGhDeferred(value) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    // Cheap token check first: never JSON-parse a multi-MB payload just to learn it is not a deferral.
    if (!String(value).includes('deferred-low-budget')) return false;
    try { value = JSON.parse(String(value)); } catch { return false; }
  }
  return value?.outcome === 'deferred-low-budget';
}

/** Card 308: retryable slot throttling shared by readers without importing the gh runner. */
export function isGhThrottled(value) {
  if (value?.ghThrottled || value?.throttled === true) return true;
  const text = typeof value === 'string' || Buffer.isBuffer(value) ? value : value?.stderr;
  return (typeof text === 'string' || Buffer.isBuffer(text)) && String(text).includes('gh-throttle: throttled');
}
