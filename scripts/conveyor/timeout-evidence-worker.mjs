import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { probeTimeoutEvidenceThrottle } from './timeout-evidence-pool.mjs';
import { readTimeoutEvidence } from './reconcile-pass.mjs';
const [input, output] = process.argv.slice(2);
let degraded = false;
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (/gh-throttle:.*(?:fail-open|running this call ungated)/.test(String(chunk))) {
    degraded = true;
    stderrWrite(chunk, ...args);
    reportFailure(); // Stop inside the warning, before the throttle can run ungated.
  }
  return stderrWrite(chunk, ...args);
};
const failure = () => ({ workerError: true, ...(degraded ? { reason: 'throttle-degraded' } : {}) });
function reportFailure() {
  try {
    writeFileSync(output + '.tmp', JSON.stringify(failure()));
    renameSync(output + '.tmp', output);
  } catch {}
  process.exit(1);
}
try {
  if (probeTimeoutEvidenceThrottle() !== true) { degraded = true; reportFailure(); }
} catch { degraded = true; reportFailure(); }
try {
  const { pr, repo, task } = JSON.parse(readFileSync(input, 'utf8'));
  const value = task
    ? await (await import(task.module))[task.exportName](pr, task.options)
    : readTimeoutEvidence(pr, { repo });
  writeFileSync(output + '.tmp', JSON.stringify(degraded ? failure() : { value }));
  renameSync(output + '.tmp', output);
  process.exit(0);
} catch { reportFailure(); }
