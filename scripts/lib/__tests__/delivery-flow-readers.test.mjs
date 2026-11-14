import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { DELIVERY_FLOW_READERS } from '../delivery-flow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function readers(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return readers(path);
    if (!/\.[cm]?[jt]s$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) return [];
    // Restrict all imports/re-exports of the policy module, including namespace/dynamic imports:
    // a namespace or re-export must not provide an unguarded second route to deliveryFlowFor.
    const imports = [...readFileSync(path, 'utf8').matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]*delivery-flow\.mjs)['"]/g)];
    return imports.some(([, specifier]) => resolve(dirname(path), specifier) === join(root, 'scripts/lib/delivery-flow.mjs'))
      ? [relative(root, path)] : [];
  });
}

describe('DELIVERY_FLOW_READERS', () => {
  it('allows only dispatch IO, the deliver-item wrapper, and the show IO; PR1 has only show IO', () => {
    expect(DELIVERY_FLOW_READERS).toEqual([
      'scripts/operations/dispatch-lane-io.mjs', 'scripts/operations/deliver-item-wrapper.mjs', 'scripts/operations/delivery-flow-io.mjs',
    ]);
    const actual = [...readers(join(root, 'scripts')), ...readers(join(root, 'skills-src'))].sort();
    expect(actual.filter(path => !DELIVERY_FLOW_READERS.includes(path))).toEqual([]);
    expect(actual).toEqual(['scripts/operations/delivery-flow-io.mjs']);
  });
});
