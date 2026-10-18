/** Tests-first delivery settings: standard → platform → repository → environment. */
import { cascadePolicy, platformPreference, formatCascadeSourcesLine, logCascadeSources } from './policy-cascade.mjs';
import { isUnderTest } from './under-test.mjs';
import { readSettings } from './settings-files.mjs';

export const TESTS_FIRST_DEFAULTS = Object.freeze({
  requireExecutableAcceptance: true, redFirst: true, guaranteesMapToTests: true,
});
const select = value => Object.fromEntries(Object.keys(TESTS_FIRST_DEFAULTS)
  .filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
export function readTestsFirstPolicy({ env = process.env, read = readSettings, platform, log } = {}) {
  let tool;
  try { tool = read()?.build; } catch { /* retain the defaults on unreadable settings */ }
  const envValues = {};
  for (const key of Object.keys(TESTS_FIRST_DEFAULTS)) {
    const name = `WE_BUILD_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
    if (env[name] !== undefined) envValues[key] = env[name] === '1' || env[name] === 'true' ? true
      : env[name] === '0' || env[name] === 'false' ? false : env[name];
  }
  const resolved = cascadePolicy('build', select(tool), {
    standard: TESTS_FIRST_DEFAULTS,
    platform: select(platform ?? platformPreference('build', { env })),
    envValues, valid: Object.fromEntries(Object.keys(TESTS_FIRST_DEFAULTS).map(key => [key, v => typeof v === 'boolean'])),
    env, log,
  });
  // CLI readers must also name the setting source; honour the shared explicit logging opt-out.
  if (!isUnderTest() && !isUnderTest(env)) logCascadeSources('build', resolved, {
    env: { ...env, WE_POLICY_CASCADE_LOG: env.WE_POLICY_CASCADE_LOG ?? '1' }, ...(log ? { log } : {}),
  });
  return resolved;
}
export const RED_FIRST_RULE = 'The FIRST commit must contain only new or updated acceptance tests. Before implementation, run those tests through `node scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-file>` and record the observed failure (command, test names, and output). Commit the failing tests with a tight pathspec, then implement. The final report must include red-then-green evidence with test names, commands, and observed results. Never claim a red run you did not observe.';
export const GUARANTEE_TEST_RULE = "each stated guarantee in the card's Acceptance has a named test; list any guarantee without one as a finding";

/** Static brief sections carry policy keys; render at the dispatch IO edge. */
export function applyTestsFirstPolicy(text, policy = readTestsFirstPolicy()) {
  return String(text).replace(/<!-- tests-first:(\w+) -->\n([\s\S]*?)<!-- \/tests-first -->/g,
    (_all, key, content) => policy.value[key] === true
      ? `${content.trim()}\n<!-- build.${key}=true (${policy.sources[key]}) -->` : '');
}
export function testsFirstWorkerRule(policy = readTestsFirstPolicy()) {
  return policy.value.redFirst ? `${RED_FIRST_RULE}\n   ${formatCascadeSourcesLine('build', policy)}` : '';
}

/** Advisory only: git failures are an explicit unknown, never evidence of compliance. */
export function redFirstWarning({ git, lease = null, policy = readTestsFirstPolicy() }) {
  if (!policy.value.redFirst) return null;
  try {
    const branch = git(['branch', '--show-current']).trim();
    if (lease?.purpose !== 'conveyor-delivery'
        && !/^lane\/(?:\d+|x[a-z0-9]{6})[a-z]?-build(?:-|$)/i.test(branch)) return null;
    const first = git(['rev-list', '--reverse', '--topo-order', 'origin/main..HEAD']).trim().split('\n')[0];
    if (!first) return 'build.redFirst: unable to inspect first build commit (no commits in range).';
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=AM', first]).trim().split('\n');
    if (!files.some(path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))) {
      return `build.redFirst: first build commit ${first.slice(0, 8)} adds or updates no tests (advisory; ${policy.sources.redFirst}).`;
    }
    return null;
  } catch { return 'build.redFirst: first build commit could not be inspected (advisory; unknown).'; }
}
