export const EVIDENCE_READ_BACKOFF_MS = [500, 1500, 4000];

export function isEvidenceReadTimeout(error) {
  // evidence-read-deadline is the scan budget checked BEFORE starting a request.
  // Successful but slow scans fall back to ordinary healing instead of retrying
  // the same pages forever. Only an actual request timeout makes evidence unknown.
  if (error?.code === 'ETIMEDOUT' || error?.message === 'spawnSync gh ETIMEDOUT') return true;
  // Validation/parse errors can quote arbitrary check names. Only a Go HTTP
  // transport diagnostic (gh stderr, or the bare diagnostic) is timeout evidence.
  // Only process stderr may contain shim warnings around the gh diagnostic.
  // Classify complete lines, but require EVERY remaining line to be a transport
  // diagnostic: validation text quoting one must not become timeout evidence.
  const diagnostic = (error?.stderr != null
    ? String(error.stderr).split(/\r?\n/).filter(line => !line.startsWith('gh-shim:')).join('\n')
    : String(error?.message ?? '')).trim();
  const lines = diagnostic.split(/\r?\n/);
  const dialTimeout = /^dial tcp [^\s"']+: i\/o timeout$/;
  // gh may prefix a bare dial error with this connection summary.
  if (lines[0] === 'error connecting to api.github.com' && dialTimeout.test(lines[1] ?? '')) lines.shift();
  return lines.every(line => {
    if (dialTimeout.test(line)) return true;
    const request = /^(?:Get|Head|Post|Put|Patch|Delete|Options) "https?:\/\/[^"\r\n]+": ([^\r\n]+)$/.exec(line);
    return !!request && /(?:\bi\/o timeout|\bTLS handshake timeout|\bcontext deadline exceeded|\bClient\.Timeout exceeded while awaiting headers|\b(?:connection|operation) timed out)\)?$/.test(request[1]);
  });
}

export function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
