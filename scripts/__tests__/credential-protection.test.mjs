/** Run the node:test contract cases through the repository's admitted Vitest entry. */
import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('R1082 node:test credential boundary contracts', () => {
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('./credential-protection.node.mjs', import.meta.url))],
    { env: process.env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 35000);
