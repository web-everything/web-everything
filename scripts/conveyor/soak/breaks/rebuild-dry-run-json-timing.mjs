/** Run the real CLI and preview source with hermetic ESM dependencies; no git, network or disk writes. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROBE = String.raw`
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import * as path from 'node:path';
import * as url from 'node:url';
const { cli, preview, cliUrl, json } = JSON.parse(readFileSync(0, 'utf8'));
let finish;
const done = new Promise(resolve => { finish = resolve; });
const cliProcess = {
  argv: [process.execPath, url.fileURLToPath(cliUrl), '--clone=/fixture/clone', '--dry-run', ...(json ? ['--json'] : [])],
  env: {},
  stdout: { write(s) { process.stdout.write(s); finish(); } },
  stderr: { write(s) { process.stderr.write(s); finish(); } },
};
const sha = 'a'.repeat(40);
let acquired = false;
let released = false;
let fetched = false;
let planned = false;
const held = () => { if (!acquired || released) throw new Error('preview ran without its smoke slot'); };
const git = args => { held(); return { status: 0, stdout: args[0] === 'symbolic-ref' ? 'main' : sha }; };
const mocks = {
  '../main-staleness.mjs': { gitRun: git },
  './shared.mjs': { makeGit: () => git, verifyRev: () => { held(); return sha; }, FULL_SHA_RE: /^[a-f0-9]{40}$/, OVERLAY_EDGE_RESOLVE_ENV: 'EDGE' },
  './local-state.mjs': { findUnsafeLocalState: () => ({ safe: true, untracked: [] }), knownInputsOf: () => ({}) },
  '../daemon-overlays.mjs': { overlayFilePath: () => '/fixture/overlays.json', readOverlayState: () => ({ overlays: [], corrupt: false }) },
  './state.mjs': { readRebuildState: () => ({}) },
  'node:fs': { mkdtempSync: () => '/fixture/scratch', mkdirSync() {}, writeFileSync() {}, rmSync() {} },
  'node:path': path,
  'node:os': { tmpdir: () => '/fixture' },
  'node:child_process': { spawnSync: () => { held(); return { status: 0 }; } },
  './edge-fetch.mjs': { fetchMainAndOverlays: () => { held(); fetched = true; }, defaultPrState() {} },
  './plan.mjs': { planRebuild: async () => { held(); planned = true; return { ok: true, finalSha: sha }; },
    supersededOverlays() { throw new Error('unexpected conflict preview'); } },
  './audited-tip.mjs': { makeAuditedTipGate() {} },
  '../daemon-self-sync.mjs': { isSafeBranchName: () => true },
  '../daemon-smoke-slots.mjs': { acquireSmokeSlot: async () => { acquired = true; return { acquired: true, release() { released = true; } }; } },
  './overlay-strategies.mjs': { resolveOverlayConflict() {} },
};
// Native ESM hooks keep the source unchanged without experimental VM modules, which can crash Node.
const bindProcess = source => source.replace(/^(#![^\n]*\n)?/, '$&const process = globalThis.__dryRunProbeProcess;\n');
const sources = {
  [cliUrl]: bindProcess(cli),
  'probe:preview': bindProcess(preview),
  'probe:facade': "export { dryRunRebuild } from 'probe:preview'; export function rebuildClone() { throw new Error('unexpected real rebuild'); }",
  'probe:lock': "export function writeRebuildRequest() { throw new Error('unexpected write'); }",
};
const previewImports = {};
globalThis.__dryRunProbeMocks = mocks;
for (const [specifier, values] of Object.entries(mocks)) {
  const id = 'probe:mock/' + Object.keys(previewImports).length;
  previewImports[specifier] = id;
  sources[id] = Object.keys(values).map((key, i) =>
    'const v' + i + ' = globalThis.__dryRunProbeMocks[' + JSON.stringify(specifier) + '][' + JSON.stringify(key) + ']; export { v' + i + ' as ' + key + ' };'
  ).join('\n');
}
const loaderSource = [
  'let data; export function initialize(value) { data = value; }',
  'export async function resolve(specifier, context, nextResolve) {',
  '  let target;',
  "  if (context.parentURL === 'probe:preview') {",
  "    if (!Object.hasOwn(data.previewImports, specifier)) throw new Error('unmocked preview dependency: ' + specifier);",
  '    target = data.previewImports[specifier];',
  '  } else if (context.parentURL === data.cliUrl) {',
  "    if (specifier === './daemon-rebuild/index.mjs') target = 'probe:facade';",
  "    else if (specifier === './daemon-clone-lock.mjs') target = 'probe:lock';",
  "    else if (!['node:path', 'node:url'].includes(specifier)) throw new Error('unmocked CLI dependency: ' + specifier);",
  '  }',
  '  if (target || Object.hasOwn(data.sources, specifier)) return { url: target || specifier, shortCircuit: true };',
  '  return nextResolve(specifier, context);',
  '}',
  'export async function load(url, context, nextLoad) {',
  "  if (Object.hasOwn(data.sources, url)) return { format: 'module', source: data.sources[url], shortCircuit: true };",
  '  return nextLoad(url, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(loaderSource), {
  parentURL: import.meta.url, data: { sources, previewImports, cliUrl },
});
// Source modules see the fixture process; the probe's own streams remain native.
globalThis.__dryRunProbeProcess = cliProcess;
await import(cliUrl);
await done;
if (cliProcess.exitCode || !fetched || !planned || !released) throw new Error('CLI preview did not finish successfully');
`;

export function probeDryRunCli({ json = true } = {}) {
  // Resolve source files as filesystem paths: Vite treats new URL(relative, import.meta.url) as an asset.
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, '../../../lib/daemon-rebuild.mjs');
  return spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', PROBE], {
    input: JSON.stringify({
      cli: readFileSync(cliPath, 'utf8'),
      preview: readFileSync(join(here, '../../../lib/daemon-rebuild/preview.mjs'), 'utf8'),
      cliUrl: pathToFileURL(cliPath).href, json,
    }),
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  });
}

export default {
  id: 'rebuild-dry-run-json-timing',
  title: 'dry-run CLI emits one JSON document on stdout and phase timings on stderr',
  card: '5726',
  fixedBy: { sha: 'pending', where: 'lane/r1-rebuild-herd', paths: ['scripts/lib/daemon-rebuild/preview.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/lib/daemon-rebuild/preview.mjs'), 'utf8');
    return source.includes('log.error?.(`daemon-rebuild: dry-run step=object-db ms=')
      && source.includes('log.error?.(`daemon-rebuild: dry-run step=overlay-merge ms=');
  },
  async run() {
    const violations = [];
    for (const json of [true, false]) {
      const result = probeDryRunCli({ json });
      if (result.error || result.status !== 0) {
        violations.push(`CLI failed (${result.signal ?? result.status}): ${result.error?.message ?? result.stderr}`);
        continue;
      }
      if (json) {
        try {
          const value = JSON.parse(result.stdout);
          if (value.dryRun !== true || value.plan?.ok !== true || value.wouldDo !== 'nothing') {
            violations.push('JSON result did not describe the successful preview');
          }
        } catch (error) { violations.push('JSON.parse(stdout) failed: ' + error.message); }
      } else if (!/^daemon-rebuild --dry-run: [^\n]+\n$/.test(result.stdout)) {
        violations.push('text stdout contained diagnostics or lacked its summary');
      }
      for (const step of ['object-db', 'overlay-merge']) {
        if (!new RegExp('daemon-rebuild: dry-run step=' + step + ' ms=\\d+').test(result.stderr)) {
          violations.push('missing stderr timing: ' + step);
        }
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
