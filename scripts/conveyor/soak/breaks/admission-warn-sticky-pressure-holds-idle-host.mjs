/** Sticky macOS warn after overnight swap must not hold an idle host with ample free memory. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const ADMISSION = 'scripts/readiness/heavy-admission.mjs';
const IDLE_WARN = { idlePctSamples: [81, 81, 81, 81], pressureLevel: 2, freePct: 45, swapGrowthMb: 0 };

export default {
  id: 'admission-warn-sticky-pressure-holds-idle-host',
  title: 'sticky memory warn admits an idle host unless scarcity corroborates it',
  card: 'admission warn corroboration',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: [ADMISSION, 'scripts/lib/memory-available.mjs'] },
  fixPresent(root) {
    const url = pathToFileURL(join(root, ADMISSION)).href;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { loadAdmissionDecision } from ${JSON.stringify(url)}; process.exit(loadAdmissionDecision(${JSON.stringify(IDLE_WARN)}).held === false ? 0 : 1);`],
    { timeout: 15000, maxBuffer: 65536, encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { loadAdmissionDecision } = await import(pathToFileURL(join(sourceRoot, ADMISSION)).href);
    const cases = [
      ['sticky warn', IDLE_WARN, false],
      ['low free memory', { ...IDLE_WARN, freePct: 10 }, true],
      ['swap growth', { ...IDLE_WARN, swapGrowthMb: 512 }, true],
      ['critical', { ...IDLE_WARN, pressureLevel: 4 }, true],
      ['missing corroboration', { pressureLevel: 2, idlePctSamples: [81] }, true],
    ];
    return { violations: cases.flatMap(([name, inputs, held]) => {
      const decision = loadAdmissionDecision(inputs);
      return decision.held === held ? [] : [`${name}: expected held=${held}, got ${JSON.stringify(decision)}`];
    }) };
  },
  judge: report => report.violations,
};
