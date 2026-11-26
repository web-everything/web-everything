import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const fixedSource = 'export const soakFix = true; export function result() { return "fixed"; }';
export const brokenSource = 'export function result() { return "broken"; }';

export function markerBreak(root) {
  return {
    id: 'marker-fixture', title: 'declared marker fixture', card: 'test-only',
    fixedBy: { sha: 'deadbeef', where: 'main' },
    fixPresent: { marker: 'fix.mjs#soakFix' },
    async run() {
      return execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { result } from ${JSON.stringify(pathToFileURL(join(root, 'fix.mjs')).href)}; process.stdout.write(result());`],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    },
    judge: result => result === 'fixed' ? [] : ['fix removed'],
  };
}
