import { vi } from 'vitest';

// Vitest 1.x stringifies undefined. Register restoration before deleting the key.
export function clearEnv(name) {
  vi.stubEnv(name, '');
  delete process.env[name];
}

// Projection fixtures must not inherit host identities, limits or shared roots.
export function clearRestrictiveEnv(registry) {
  for (const [name, rule] of Object.entries(registry)) {
    if (rule.class !== 'forward-restrictive' && !rule.restrictiveValues
      && !rule.restrictivePrefixes && !rule.tighterThan) continue;
    const names = name.endsWith('*')
      ? Object.keys(process.env).filter(key => key.startsWith(name.slice(0, -1))) : [name];
    for (const key of names) clearEnv(key);
  }
}
