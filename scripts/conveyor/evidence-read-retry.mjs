export const EVIDENCE_READ_BACKOFF_MS = [500, 1500, 4000];

export function isEvidenceReadTimeout(error) {
  if (error?.code === 'ETIMEDOUT' || error?.message === 'evidence-read-deadline'
    || error?.message === 'spawnSync gh ETIMEDOUT') return true;
  // Validation/parse errors can quote arbitrary check names. Only a Go HTTP
  // transport diagnostic (gh stderr, or the bare diagnostic) is timeout evidence.
  // Anchor the entire diagnostic: a newline embedded in a name must not qualify.
  const diagnostic = String(error?.stderr ?? error?.message ?? '').trim();
  const request = /^(?:Get|Head|Post|Put|Patch|Delete|Options) "https?:\/\/[^"\r\n]+": ([^\r\n]+)$/.exec(diagnostic);
  return !!request && /(?:\bi\/o timeout|\bTLS handshake timeout|\bcontext deadline exceeded|\bClient\.Timeout exceeded while awaiting headers|\b(?:connection|operation) timed out)\)?$/.test(request[1]);
}

export function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
