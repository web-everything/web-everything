export const EVIDENCE_READ_BACKOFF_MS = [500, 1500, 4000];

export function isEvidenceReadTimeout(error) {
  return error?.code === 'ETIMEDOUT'
    || /ETIMEDOUT|timed out/i.test(error?.message ?? '')
    || error?.message === 'evidence-read-deadline';
}

export function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
