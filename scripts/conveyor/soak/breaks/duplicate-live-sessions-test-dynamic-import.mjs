/** The duplicate-live-sessions probeAgents() case imported the heavy health-watch.mjs graph dynamically inside the
 * test, so its multi-second transform counted against the 5000 ms per-test budget and the case timed out on a busy
 * host. The import must be static (collect time); the probe itself already runs on an injected `exec`. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST = 'scripts/conveyor/health-smells/__tests__/duplicate-live-sessions.test.mjs';

export default {
  id: 'duplicate-live-sessions-test-dynamic-import',
  title: 'the duplicate-live-sessions probeAgents case dynamically imports health-watch inside the test budget',
  card: 'main-fix: duplicate-live-sessions probeAgents test timeout',
  fixedBy: { sha: '7f1c84ed30860d16c8b431ce48b039d6da778aa3', where: 'lane/main-fix-duplicate-sessions-hermetic', paths: [TEST] },
  // The fix ships in the same PR as this break, so it is always required-green and `run` checks the file itself.
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const src = readFileSync(join(root, TEST), 'utf8');
    const violations = [];
    if (/import\(\s*['"][^'"]*health-watch\.mjs['"]\s*\)/.test(src)) violations.push('health-watch.mjs is imported dynamically inside a test');
    if (!/^import\s*\{[^}]*\bprobeAgents\b[^}]*\}\s*from\s*['"][^'"]*health-watch\.mjs['"]/m.test(src)) violations.push('health-watch.mjs probeAgents is not statically imported');
    return { violations };
  },
  judge(report) { return report.violations; },
};
