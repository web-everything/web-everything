/** Read-only, fail-closed evidence that the merge-gate workflow is pinned to main. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const unknown = (reason) => ({ status: 'unknown', reason });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;

export function evaluateMergeGatePin(rulesJson) {
  if (!Array.isArray(rulesJson)) return unknown('Expected a branch-rules array; inspect the ruleset response.');
  let pinned = false;
  for (const rule of rulesJson) {
    if (!object(rule) || !text(rule.type)) return unknown('Malformed branch rule; inspect the ruleset response.');
    if (rule.type !== 'workflows') continue;
    const entries = rule.parameters?.workflows;
    if (!object(rule.parameters) || !Array.isArray(entries)) return unknown('Malformed workflows rule; inspect the ruleset response.');
    for (const entry of entries) {
      if (!object(entry) || !text(entry.path) || !text(entry.ref)) return unknown('Malformed workflow entry; inspect the ruleset response.');
      if (entry.path.endsWith('.github/workflows/merge-gate.yml') && entry.ref === 'refs/heads/main') pinned = true;
    }
  }
  return pinned
    ? { status: 'pinned', reason: 'merge-gate workflow is pinned to refs/heads/main.' }
    : { status: 'missing', reason: 'Pin .github/workflows/merge-gate.yml to refs/heads/main in the branch ruleset.' };
}

export async function probeMergeGatePin({ ghApi, repo }) {
  try {
    return evaluateMergeGatePin(JSON.parse(await ghApi(`repos/${repo}/rules/branches/main`)));
  } catch {
    return unknown('Ruleset response unavailable or unreadable; verify API access and retry.');
  }
}

export function mergeGatePinFails(result) {
  return result?.status !== 'pinned';
}

/** Explicit repo: --repo=owner/name, --repo owner/name, positional, or GH_REPO. */
export async function main({ argv = process.argv.slice(2), env = process.env, exec = execFileSync } = {}) {
  const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 };
  try {
    let repo = argv[0] === '--repo' ? argv[1] : argv[0]?.replace(/^--repo=/, '');
    repo ||= env.GH_REPO || JSON.parse(exec('gh', ['repo', 'view', '--json', 'nameWithOwner'], options)).nameWithOwner;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return unknown('Repository unavailable; pass --repo=owner/name.');
    return await probeMergeGatePin({ repo, ghApi: (endpoint) => exec('gh', ['api', endpoint], options) });
  } catch {
    return unknown('Repository lookup failed; pass --repo=owner/name or verify API access.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = mergeGatePinFails(result) ? 1 : 0;
}
