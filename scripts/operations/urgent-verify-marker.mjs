/** Urgent evidence permits prototype loading only; merging still requires real CI. */
import yaml from 'js-yaml';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const urgentKeyPath = home => `${home}/workspace/.operations/state/urgent-verify.key`;
export const normalizeUrgentRepo = url => {
  const value = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const match = value.match(/^(?:https:\/\/|ssh:\/\/(?:git@)?)([\w.-]+)\/([\w.-]+\/[\w.-]+)$/)
    ?? value.match(/^git@([\w.-]+):([\w.-]+\/[\w.-]+)$/);
  return match ? `https://${match[1].toLowerCase()}/${match[1].toLowerCase() === 'github.com' ? match[2].toLowerCase() : match[2]}` : value;
};
export const urgentFuiRepo = 'https://github.com/frontier-ui/frontierui';
export function urgentSignature(record, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('unreadable urgent key');
  const fields = ['sha', 'suite', 'shards', 'result', 'startedAt', 'finishedAt', 'host', 'repo', 'steps', 'fuiSha', 'fuiRepo'];
  return createHmac('sha256', key).update(JSON.stringify(Object.fromEntries(fields.map(k => [k, record[k]])))).digest('hex');
}
export const urgentLedger = (home, name = 'urgent-full-green') => `${home}/workspace/.operations/coordination/${name}.jsonl`;
export const urgentReason = (reason) => typeof reason === 'string' && reason.trim().length >= 10;
const fullSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);

/** Fail closed on an unknown CI layout. No shell workflow text is executed. */
export function ciUnitPlan(workflow) {
  const job = yaml.safeLoad(workflow)?.jobs?.['test-shard'];
  const matrix = job?.strategy?.matrix;
  const shards = matrix?.shard;
  if (!Array.isArray(shards) || !shards.length || shards.length > 64
    || Object.keys(matrix).length !== 1 || shards.some((v, i) => v !== i + 1)) throw new Error('unreadable-ci-shards');
  const steps = job.steps.filter(s => typeof s.run === 'string');
  const groups = steps.filter(s => s.run.includes('scripts/ci/shard-assign.mjs --suite=unit'));
  if (groups.length === 2) {
    const covered = groups.find(s => s.run.includes('--group=covered'));
    const nocov = groups.find(s => s.run.includes('--group=nocov --shard=1/1'));
    const divisor = Number(covered?.run.match(/--shard=\$\{\{ matrix.shard \}\}\/(\d+)/)?.[1]);
    if (divisor !== shards.length - 1 || !covered?.run.includes('npm run test:coverage:shard --')
      || !nocov?.run.includes('npm run test:unit --')
      || !covered.if?.includes(`matrix.shard != ${shards.length}`)
      || !nocov.if?.includes(`matrix.shard == ${shards.length}`)) throw new Error('unreadable-ci-shards');
    return shards.map(i => ({ group: i === shards.length ? 'nocov' : 'covered', shard: i === shards.length ? '1/1' : `${i}/${divisor}` }));
  }
  if (groups.length || !steps.some(s => /vitest run --shard=\$\{\{ matrix.shard \}\}\/\$\{\{ strategy.job-total \}\}/.test(s.run))) throw new Error('unreadable-ci-shards');
  return shards.map(i => ({ shard: `${i}/${shards.length}` }));
}

// Pin complete run texts, including shard-selection helpers and dependency receipts.
// Do not derive this allowlist from the workflow at runtime: new validation must update the mirror.
const runText = run => run.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
const setupRuns = ['sh scripts/ci/fetch-main-history.sh', 'npm ci', 'npm ci\nnpm run build:tools'];
const jobSetupRuns = {
  standards: setupRuns, 'test-shard': setupRuns, 'integration-part': setupRuns,
  'coverage-merge': ['npm ci'],
};
const mirroredRuns = {
  changes: ["FRESH_MAIN_SHA=\"\"\nif [ \"$EVENT_NAME\" = \"merge_group\" ]; then\n  BASE_SHA=\"$MG_BASE_SHA\"\nfi\nif [ \"$BASE_REF\" = \"main\" ]; then\n  if sh scripts/ci/fetch-main-history.sh; then\n    FRESH_MAIN_SHA=$(git rev-parse --verify --end-of-options 'refs/remotes/origin/main^{commit}') || FRESH_MAIN_SHA=\"\"\n  else\n    echo \"ci-card-only: main fetch failed; full suite\" >&2\n  fi\nfi\nnode scripts/ci-card-only.mjs --event=\"$EVENT_NAME\" --base=\"$BASE_SHA\" --base-ref=\"$BASE_REF\" --fresh-main-sha=\"$FRESH_MAIN_SHA\" --head=HEAD >> \"$GITHUB_OUTPUT\""],
  'test-shard': [
    "echo \"Card-only change; no unit tests required by the changes classifier.\"",
    `
list=$(node scripts/ci/shard-assign.mjs --suite=unit --group=covered --shard=\${{ matrix.shard }}/9) || { echo "::error::shard-assign failed; refusing to run an unfiltered suite"; exit 1; }
[ -n "$list" ] || { echo "::error::shard-assign returned an empty file list"; exit 1; }
files=()
while IFS= read -r f; do [ -z "$f" ] || files+=("$f"); done <<< "$list"
echo "unit shard \${{ matrix.shard }}/9: \${#files[@]} files"
npm run test:coverage:shard -- --reporter=default --reporter=json --outputFile.json=coverage/timing-unit-\${{ matrix.shard }}.json "\${files[@]}" $(node scripts/ci/quarantine-skip.mjs) # red-main quarantine (xx7ckd6): skip args from ops/quarantine, empty unless redMainMode=quarantine
`,
    `
list=$(node scripts/ci/shard-assign.mjs --suite=unit --group=nocov --shard=1/1) || { echo "::error::shard-assign failed; refusing to run an unfiltered suite"; exit 1; }
[ -n "$list" ] || { echo "::error::shard-assign returned an empty file list"; exit 1; }
files=()
while IFS= read -r f; do [ -z "$f" ] || files+=("$f"); done <<< "$list"
echo "unit no-coverage group: \${#files[@]} files"
npm run test:unit -- --reporter=default --reporter=json --outputFile.json=coverage/timing-unit-\${{ matrix.shard }}.json "\${files[@]}" $(node scripts/ci/quarantine-skip.mjs) # red-main quarantine (xx7ckd6): skip args from ops/quarantine, empty unless redMainMode=quarantine
`,
  ],
  'coverage-merge': [
    `
if [ "\${{ needs.test-shard.result }}" != "success" ]; then
echo "::error::Unit shards did not succeed; refusing incomplete coverage."
exit 1
fi
`,
    "npm run coverage:merge -- coverage-shards --threshold=80 --expect=9",
  ],
  'host-paths': [
    "node scripts/lint-host-paths.mjs",
  ],
  'integration-part': [
    `
if [ "\${{ needs.changes.result }}" != "success" ]; then
echo "changes (card-only detection) did not succeed (result: \${{ needs.changes.result }}) - failing closed."
exit 1
fi
if [ "\${{ needs.changes.outputs.light }}" = "true" ]; then
echo "Card-only PR: integration suite intentionally not run."
echo "run=false" >> "$GITHUB_OUTPUT"
else
echo "run=true" >> "$GITHUB_OUTPUT"
fi
`,
    "npm run test:integration:vitest -- --reporter=default --reporter=json --outputFile.json=coverage/timing-integration-${{ matrix.group }}.json $(node scripts/ci/quarantine-skip.mjs --job=\"integration\")",
  ],
  integration: [
    `
if [ "\${{ needs.changes.result }}" != "success" ]; then
echo "changes did not succeed - failing closed."
exit 1
fi
if [ "\${{ needs.integration-part.result }}" != "success" ]; then
echo "integration-part did not succeed - failing closed."
exit 1
fi
`,
  ],
  'test': [
    `
if [ "\${{ needs.changes.result }}" != "success" ]; then
echo "::error::Changes detection did not succeed."
exit 1
fi
if [ "\${{ needs.integration.result }}" != "success" ]; then
echo "::error::Integration did not succeed."
exit 1
fi
if [ "\${{ needs.standards.result }}" != "success" ]; then
echo "::error::Standards did not succeed."
exit 1
fi
if [ "\${{ needs.host-paths.result }}" != "success" ]; then
echo "::error::Host paths did not succeed."
exit 1
fi
if [ "\${{ needs.changes.outputs.light }}" = "true" ]; then
echo "Card-only PR: unit shards and coverage merge intentionally omitted."
exit 0
fi
if [ "\${{ needs.test-shard.result }}" != "success" ]; then
echo "::error::Unit shards did not succeed."
exit 1
fi
if [ "\${{ needs.coverage-merge.result }}" != "success" ]; then
echo "::error::Coverage merge did not succeed."
exit 1
fi
`,
  ],
  'standards': [
    "npm run check:standards",
  ],
};

// Ordered uses-step signatures observed in ci.yml, independent of the input workflow.
// Pin the complete with mapping: additions, removals and option changes require a mirror review.
const siblingActions = [
  { name: 'Checkout WE', uses: 'actions/checkout@v4', with: { path: 'web-everything', 'fetch-depth': 50 } },
  { name: 'Mint FUI read token (GitHub App)', if: "vars.WE_APP_ID != ''", uses: 'actions/create-github-app-token@v2', with: {
    'app-id': '${{ vars.WE_APP_ID }}', 'private-key': '${{ secrets.WE_APP_PRIVATE_KEY }}',
    owner: 'frontier-ui', repositories: 'frontierui', 'permission-contents': 'read',
  } },
  { name: 'Checkout FUI (sibling)', uses: 'actions/checkout@v4', with: {
    repository: 'frontier-ui/frontierui', token: '${{ steps.fui-app-token.outputs.token || secrets.FUI_READ_TOKEN }}', path: 'frontierui',
  } },
  { name: undefined, uses: 'actions/setup-node@v4', with: {
    'node-version': 22, cache: 'npm', 'cache-dependency-path': 'web-everything/package-lock.json\nfrontierui/package-lock.json\n',
  } },
];
const mirroredActions = {
  changes: [{ name: undefined, uses: 'actions/checkout@v4', with: { 'fetch-depth': 50 } }],
  standards: siblingActions,
  'integration-part': [...siblingActions.map(step => ({ ...step, if: step.name === 'Mint FUI read token (GitHub App)' ? step.if : "${{ steps.gate.outputs.run == 'true' }}" })),
    { name: 'Upload integration timings', if: "${{ needs.changes.outputs.light != 'true' && (always()) }}", uses: 'actions/upload-artifact@v4', with: {
      name: 'timing-integration-${{ matrix.group }}', path: 'web-everything/coverage/timing-integration-${{ matrix.group }}.json', 'if-no-files-found': 'ignore',
    } },
  ],
  integration: [],
  'test-shard': [...siblingActions.map(step => ({ ...step, if: step.name === 'Mint FUI read token (GitHub App)'
    ? "${{ needs.changes.outputs.light != 'true' && (vars.WE_APP_ID != '') }}" : "${{ needs.changes.outputs.light != 'true' }}" })),
    { name: 'Upload shard coverage', if: "${{ needs.changes.outputs.light != 'true' && (matrix.shard != 10) }}", uses: 'actions/upload-artifact@v4', with: {
      name: 'coverage-shard-${{ matrix.shard }}', path: 'web-everything/coverage/coverage-final.json', 'if-no-files-found': 'error',
    } },
    { name: 'Upload shard timings', if: "${{ needs.changes.outputs.light != 'true' && (always()) }}", uses: 'actions/upload-artifact@v4', with: {
      name: 'timing-unit-${{ matrix.shard }}', path: 'web-everything/coverage/timing-unit-${{ matrix.shard }}.json', 'if-no-files-found': 'ignore',
    } },
  ],
  'coverage-merge': [
    { name: undefined, uses: 'actions/checkout@v4', with: { path: 'web-everything' } },
    { name: undefined, uses: 'actions/setup-node@v4', with: {
      'node-version': 22, cache: 'npm', 'cache-dependency-path': 'web-everything/package-lock.json',
    } },
    { name: 'Download shard coverage', uses: 'actions/download-artifact@v4', with: {
      path: 'web-everything/coverage-shards', pattern: 'coverage-shard-*',
    } },
  ],
  'host-paths': [
    { name: undefined, uses: 'actions/checkout@v4', with: undefined },
    { name: undefined, uses: 'actions/setup-node@v4', with: { 'node-version': 22 } },
  ],
  test: [],
};

// Execution contexts observed in ci.yml, pinned independently of the input workflow.
const fullUnit = "${{ needs.changes.outputs.light != 'true' }}";
const fullIntegration = "${{ steps.gate.outputs.run == 'true' }}";
function mirroredRunContext(job, text) {
  const index = mirroredRuns[job].map(runText).indexOf(text);
  const setup = setupRuns.includes(text);
  const directory = text === 'npm ci\nnpm run build:tools' ? 'frontierui'
    : setup || job === 'standards' || (job === 'coverage-merge' && index === 1)
      || (job === 'test-shard' && index > 0) || (job === 'integration-part' && index === 1) ? 'web-everything' : undefined;
  const condition = job === 'test-shard' ? (setup ? fullUnit : [
    "${{ needs.changes.outputs.light == 'true' }}",
    "${{ needs.changes.outputs.light != 'true' && (matrix.shard != 10) }}",
    "${{ needs.changes.outputs.light != 'true' && (matrix.shard == 10) }}",
  ][index]) : job === 'integration-part' && (setup || index === 1) ? fullIntegration : undefined;
  return {
    'working-directory': directory, if: condition, shell: undefined, 'continue-on-error': undefined,
    env: job === 'changes' ? {
      EVENT_NAME: '${{ github.event_name }}', BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      MG_BASE_SHA: '${{ github.event.merge_group.base_sha }}', BASE_REF: '${{ github.event.pull_request.base.ref }}',
    } : job === 'integration-part' && index === 1 ? { WE_INTEGRATION_GROUP: '${{ matrix.group }}' } : undefined,
  };
}

/** Required closure is workflow-owned; an unfamiliar dependency refuses urgent loading. */
export function ciRequiredJobs(workflow) {
  const jobs = yaml.safeLoad(workflow)?.jobs, seen = new Set(), visiting = new Set();
  const visit = name => {
    if (visiting.has(name) || !jobs?.[name] || (name !== 'test' && !Object.hasOwn(mirroredRuns, name)))
      throw new Error('unreadable-ci-gates: unknown or cyclic required job');
    if (seen.has(name)) return;
    visiting.add(name);
    const needs = jobs[name].needs ?? [];
    const list = typeof needs === 'string' ? [needs] : needs;
    if (!Array.isArray(list) || list.some(n => typeof n !== 'string')) throw new Error('unreadable-ci-gates');
    for (const n of list) visit(n);
    visiting.delete(name); seen.add(name);
  };
  visit('test');
  return [...seen];
}

/** Mirror only the known CI command and artifact layout; changes require an operator update. */
export function ciGatePlan(workflow) {
  const document = yaml.safeLoad(workflow), jobs = document?.jobs;
  const requiredJobs = ciRequiredJobs(workflow);
  if (document.env !== undefined || document.defaults?.run !== undefined)
    throw new Error('unreadable-ci-gates: workflow execution context; update the urgent verification mirror');
  // Local verification runs the full, ungrouped integration inventory once. Only this
  // reviewed matrix and aggregator layout are equivalent to that local execution.
  const integrationGroups = ['scan-chain', 'sim-scenarios', 'lane-pool-a', 'lane-pool-b', 'parallel'];
  if (!isDeepStrictEqual(jobs.integration?.needs, ['changes', 'integration-part'])
    || jobs.integration?.if !== '${{ always() }}' || jobs.integration?.strategy !== undefined
    || jobs['integration-part']?.needs !== 'changes' || jobs['integration-part']?.if !== '${{ !cancelled() }}'
    || !isDeepStrictEqual(jobs['integration-part']?.strategy, {
      'fail-fast': false, matrix: { group: integrationGroups, include: integrationGroups.map(group => ({ group, timeout: 20 })) },
    })) throw new Error('unreadable-ci-gates: integration layout; update the urgent verification mirror');
  for (const job of requiredJobs) {
    const mirrored = mirroredRuns[job];
    const steps = jobs?.[job]?.steps;
    const expectedRuns = [...(jobSetupRuns[job] ?? []), ...mirrored].map(runText);
    const allowed = new Set(expectedRuns);
    if (!Array.isArray(steps) || steps.some(s => !s || typeof s !== 'object' || ('run' in s &&
      (typeof s.run !== 'string' || !allowed.has(runText(s.run))))))
      throw new Error(`unreadable-ci-gates: update the urgent verification mirror for ${job} run or uses steps`);
    const actualActions = steps.filter(s => 'uses' in s).map(s => ({ name: s.name, uses: s.uses, with: s.with, if: s.if, env: s.env, 'continue-on-error': s['continue-on-error'] }));
    if (!isDeepStrictEqual(actualActions, mirroredActions[job].map(s => ({ if: undefined, env: undefined, 'continue-on-error': undefined, ...s }))))
      throw new Error(`unreadable-ci-gates: update the urgent verification mirror for ${job} uses steps`);
    // Every accepted command must belong to the local mirror, exactly once.
    const actualRuns = steps.filter(s => 'run' in s).map(s => runText(s.run));
    if (actualRuns.length !== expectedRuns.length || expectedRuns.some(text => actualRuns.filter(run => run === text).length !== 1))
      throw new Error(`unreadable-ci-gates: ${job} command layout; update the urgent verification mirror`);
    const sibling = ['standards', 'test-shard', 'integration-part'].includes(job);
    const checkouts = steps.filter(s => s.uses === 'actions/checkout@v4');
    const expectedCheckouts = sibling ? 2 : ['test', 'integration'].includes(job) ? 0 : 1;
    if (checkouts.length !== expectedCheckouts || checkouts.some((checkout, index) => {
      const options = checkout.with ?? {};
      const fui = sibling && index === 1;
      const path = fui ? 'frontierui' : sibling || job === 'coverage-merge' ? 'web-everything' : undefined;
      return Object.hasOwn(options, 'ref') || options.path !== path
        || (fui ? options.repository !== 'frontier-ui/frontierui' : Object.hasOwn(options, 'repository'));
    })) throw new Error(`unreadable-ci-gates: ${job} checkout layout; update the urgent verification mirror`);
    if (jobs[job].defaults?.run !== undefined || jobs[job].env !== undefined || jobs[job].container !== undefined
      || jobs[job]['continue-on-error'] !== undefined)
      throw new Error(`unreadable-ci-gates: ${job} execution context; update the urgent verification mirror`);
    for (const step of steps.filter(s => 'run' in s)) {
      const expected = mirroredRunContext(job, runText(step.run));
      if (Object.entries(expected).some(([key, value]) => !isDeepStrictEqual(step[key], value)))
        throw new Error(`unreadable-ci-gates: ${job} step execution context; update the urgent verification mirror`);
    }
  }
  const plan = ciUnitPlan(workflow);
  const covered = plan.filter(s => s.group === 'covered').length;
  const step = (job, name) => {
    const matches = jobs?.[job]?.steps?.filter(s => s.name === name);
    if (matches?.length !== 1) throw new Error('unreadable-ci-gates');
    return matches[0];
  };
  const merge = step('coverage-merge', 'Merge coverage + enforce 80% bar (#2082)').run;
  const host = step('host-paths', 'Host-local path ratchet').run;
  const integration = step('integration-part', 'Real-git integration suite (lane-pool, operations transport)').run;
  const upload = step('test-shard', 'Upload shard coverage');
  const download = step('coverage-merge', 'Download shard coverage');
  if (!covered || merge !== `npm run coverage:merge -- coverage-shards --threshold=80 --expect=${covered}`
    || host !== 'node scripts/lint-host-paths.mjs'
    || integration !== 'npm run test:integration:vitest -- --reporter=default --reporter=json --outputFile.json=coverage/timing-integration-${{ matrix.group }}.json $(node scripts/ci/quarantine-skip.mjs --job="integration")'
    || upload.uses !== 'actions/upload-artifact@v4' || upload.with?.name !== 'coverage-shard-${{ matrix.shard }}'
    || upload.with?.path !== 'web-everything/coverage/coverage-final.json' || upload.with?.['if-no-files-found'] !== 'error'
    || !upload.if?.includes(`matrix.shard != ${plan.length}`)
    || download.uses !== 'actions/download-artifact@v4' || download.with?.path !== 'web-everything/coverage-shards'
    || download.with?.pattern !== 'coverage-shard-*' || download.with?.['merge-multiple'] === true) throw new Error('unreadable-ci-gates');
  for (const job of ['standards', 'test-shard', 'integration-part']) {
    const fui = step(job, 'Install + build FUI tools'), install = step(job, 'Install');
    if (runText(fui.run ?? '') !== 'npm ci\nnpm run build:tools' || fui['working-directory'] !== 'frontierui'
      || runText(install.run ?? '') !== 'npm ci' || install['working-directory'] !== 'web-everything'
      || jobs[job].steps.indexOf(fui) >= jobs[job].steps.indexOf(install)) throw new Error('unreadable-ci-gates: install layout');
  }
  const fetchMain = runText(step('test-shard', 'Fetch main history (blobless)').run);
  if (fetchMain !== 'sh scripts/ci/fetch-main-history.sh') throw new Error('unreadable-ci-gates: main history command');
  return { requiredJobs, fetchMain: fetchMain.split(' '), installFui: [['npm', 'ci'], ['npm', 'run', 'build:tools']], install: ['npm', 'ci'], coverage: merge.split(' '), hostPaths: host.split(' '), integration: integration.split(' -- ')[0].split(' ') }; // CI-only reporter flags (per-group timing JSON) stay out of the one ungrouped local run
}

export function urgentMarker({ urgent, reason, sha, ledger, shards, expectedSteps, now, repo, readKey }) {
  const no = (detail) => ({ ok: false, detail, fallback: `Run node scripts/operations/run.mjs urgent-verify --sha=${sha} in a clean checkout, then retry with --urgent --reason=<at least 10 characters>; or wait for passing CI.` });
  if (urgent !== true || !urgentReason(reason) || !fullSha(sha)) return no('no-urgent-marker');
  try {
    const records = ledger.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    const marker = records.filter(r => r?.sha === sha).at(-1);
    const finished = typeof marker?.finishedAt === 'string' ? Date.parse(marker.finishedAt) : NaN;
    const started = typeof marker?.startedAt === 'string' ? Date.parse(marker.startedAt) : NaN;
    if (!Number.isInteger(shards) || shards < 1 || !marker || marker.suite !== 'full' || marker.result !== 'green'
      || marker.shards !== shards || !Number.isFinite(now) || !Number.isFinite(finished) || !(started < finished)
      || now - finished > 2 * 60 * 60_000 || finished - now > 5 * 60_000
      || typeof marker.host !== 'string' || !marker.host.trim()) return no('no-urgent-marker');
    if (!fullSha(marker.fuiSha) || marker.fuiRepo !== urgentFuiRepo || !repo || marker.repo !== repo || !Array.isArray(marker.steps)
      || !Array.isArray(expectedSteps) || expectedSteps.length !== shards + 7
      || marker.steps.length !== expectedSteps.length || !expectedSteps.every((step, i) => marker.steps[i] === step)
      || !/^[a-f0-9]{64}$/.test(marker.sig ?? '')
      || !timingSafeEqual(Buffer.from(marker.sig, 'hex'), Buffer.from(urgentSignature(marker, readKey()), 'hex'))) return no('no-urgent-marker');
    return { ok: true, evidence: { source: 'urgent-local-full', marker, reason } };
  } catch { return no('no-urgent-marker'); }
}
