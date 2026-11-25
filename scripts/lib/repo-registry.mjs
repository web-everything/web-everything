/**
 * @file scripts/lib/repo-registry.mjs
 * @description Reader for the one repo registry, scripts/settings/repos.json (REPO-REGISTRY-HEALTH).
 *   Each repo: name, slug, aliases, ownerPath, daemons, mergePath, appInstallationId.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'repos.json');
const REQUIRED = ['name', 'slug', 'ownerPath', 'daemons', 'mergePath', 'appInstallationId'];

export function loadRepoRegistry(file = REGISTRY_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function registryNames(reg) {
  return (reg.repos ?? []).map((r) => r.name);
}

/** Find a repo by name, slug, slug tail or alias. */
export function findRepo(reg, key) {
  return (reg.repos ?? []).find((r) => [r.name, r.slug, ...(r.aliases ?? [])].includes(key)
    || r.slug?.split('/')[1] === key) ?? null;
}

/** Returns a list of problems; empty when the registry is well formed. */
export function validateRegistry(reg) {
  const problems = [];
  for (const r of reg.repos ?? []) {
    for (const f of REQUIRED) if (!(f in r)) problems.push(`${r.name ?? '?'}: missing ${f}`);
  }
  return problems;
}
