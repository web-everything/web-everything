import { statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the operated checkout, independently of the trusted snapshot location. */
export function hookRoot(importMetaUrl) {
  const root = process.env.WE_HOOK_ROOT;
  if (root !== undefined) {
    if (!isAbsolute(root) || !statSync(root).isDirectory()) {
      throw new Error('WE_HOOK_ROOT must be an absolute, existing directory');
    }
    return root;
  }
  return resolve(dirname(fileURLToPath(importMetaUrl)), '..');
}
