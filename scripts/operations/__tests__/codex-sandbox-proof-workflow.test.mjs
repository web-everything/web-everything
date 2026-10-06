/**
 * @file codex-sandbox-proof-workflow.test.mjs — #4807 contract for `.github/workflows/codex-sandbox-proof.yml`,
 * the manual run that proves the Codex native sandbox on a candidate CLI version. The workflow cannot run in
 * unit tests, so the properties that make a requested run trustworthy are asserted on its parsed YAML, each with
 * a mutation that must be rejected: manual-only on macOS, exact version, both opt-in variables, only the named
 * suites, no failure swallowing, and a verify step that cannot be satisfied by skipped cases.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChecked } from './helpers/codex-sandbox-fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const raw = readFileSync(join(root, '.github/workflows/codex-sandbox-proof.yml'), 'utf8');
const { load } = await import('js-yaml');

const SUITES = [
  'scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs',
  'scripts/operations/__tests__/codex-delivery-provider-sandbox-guards.test.mjs',
];

const stepNamed = (doc, re) => doc.jobs.proof.steps.find((s) => re.test(s.name ?? ''));
const runText = (step) => String(step?.run ?? '').replace(/\s+/g, ' ');
const visitAll = (value, visit) => {
  visit(value);
  if (value && typeof value === 'object') Object.values(value).forEach((v) => visitAll(v, visit));
};

/** Every contract violation in a parsed workflow document (empty = trustworthy). */
export function workflowIssues(doc) {
  const issues = [];
  const triggers = Object.keys(doc.on ?? doc.true ?? {});
  if (triggers.join() !== 'workflow_dispatch') issues.push(`triggers must be exactly workflow_dispatch, got ${triggers.join() || 'none'}`);
  const input = (doc.on ?? doc.true)?.workflow_dispatch?.inputs?.codex_version;
  if (!input || input.required !== true) issues.push('codex_version input must be required');
  if (!/^macos-/.test(doc.jobs?.proof?.['runs-on'] ?? '')) issues.push('job must run on a macos runner (documented Seatbelt claim)');
  visitAll(doc, (node) => { if (node && typeof node === 'object' && 'continue-on-error' in node) issues.push('continue-on-error is forbidden'); });
  for (const step of doc.jobs?.proof?.steps ?? []) {
    if (/\|\|\s*(true|:)/.test(String(step.run ?? ''))) issues.push(`step "${step.name}" swallows failure with || true`);
  }

  const install = stepNamed(doc, /install the exact codex/i);
  const installText = runText(install);
  if (!/npm install --global "@openai\/codex@\$\{CODEX_VERSION\}"/.test(installText)) issues.push('install must pin @openai/codex@${CODEX_VERSION}');
  if (doc.jobs?.proof?.env?.CODEX_VERSION !== '${{ inputs.codex_version }}') issues.push('CODEX_VERSION must come from the input');
  if (/\$\{\{[^}]*inputs\.codex_version[^}]*\}\}/.test(String(install?.run ?? ''))) issues.push('the version input must not be interpolated into a script');
  if (!/codex --version/.test(installText) || !/uname/.test(installText) || !/sw_vers/.test(installText)) issues.push('install must print CLI and host versions');
  if (!/does not match requested/.test(installText)) issues.push('install must fail on a version mismatch');
  if (!installText.includes('"${ACTUAL##* }" != "$CODEX_VERSION"')) issues.push('install must compare the CLI version exactly, not by substring');

  const test = stepNamed(doc, /live sandbox proof/i);
  if (test?.env?.WE_TEST_SANDBOX !== '0') issues.push('WE_TEST_SANDBOX=0 is missing from the proof step');
  if (test?.env?.WE_CODEX_SANDBOX_TEST !== '1') issues.push('WE_CODEX_SANDBOX_TEST=1 is missing from the proof step');
  if (!test?.env?.WE_CODEX_SANDBOX_EVIDENCE) issues.push('the live suite evidence path is missing');
  const cmd = runText(test);
  const targets = cmd.match(/\S+\.test\.mjs/g) ?? [];
  if (targets.join() !== SUITES.join()) issues.push(`proof step must run exactly the named suites, got: ${targets.join(' ') || 'none'}`);
  if (/\s-t\s|--testNamePattern|--passWithNoTests|--bail/.test(cmd)) issues.push('proof step must not filter or tolerate empty runs');
  if (!/--reporter=json/.test(cmd)) issues.push('proof step must write a JSON report');
  if (test?.['continue-on-error'] !== undefined) issues.push('proof step must not continue on error');

  const verify = stepNamed(doc, /verify nothing was skipped/i);
  const vtext = String(verify?.run ?? '');
  for (const needle of ['.success == true', '.numFailedTests == 0', '.numPendingTests == 0', '.status != "passed"', '>= $min', 'live-evidence.json']) {
    if (!vtext.includes(needle)) issues.push(`verify step lost its "${needle}" check`);
  }
  if (!/LIVE_MIN_CASES/.test(JSON.stringify(doc.jobs?.proof?.env ?? {}))) issues.push('LIVE_MIN_CASES must be declared');

  const upload = (doc.jobs?.proof?.steps ?? []).find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
  if (!upload || upload.if !== 'always()') issues.push('evidence upload must run if: always()');
  if (!/proof-evidence/.test(String(upload?.with?.path ?? ''))) issues.push('upload must carry the proof-evidence directory');
  const order = (doc.jobs?.proof?.steps ?? []).map((s) => s.name ?? s.uses);
  if (order.indexOf(test?.name) < order.indexOf(install?.name)) issues.push('the CLI must be installed before the proof runs');
  return issues;
}

const clone = () => structuredClone(load(raw));

describe('4807 codex-sandbox-proof workflow contract', () => {
  it('the shipped workflow satisfies every property', () => {
    expect(workflowIssues(load(raw))).toEqual([]);
  });

  it('the live suite size it demands matches the live suite', () => {
    const live = readFileSync(join(root, SUITES[0]), 'utf8');
    const cases = (live.match(/^\s+it\('/gm) ?? []).length;
    expect(Number(load(raw).jobs.proof.env.LIVE_MIN_CASES)).toBe(cases);
  });

  const mutations = [
    ['add a push trigger', (d) => { d.on.push = { branches: ['main'] }; }, /workflow_dispatch/],
    ['add a pull_request trigger', (d) => { d.on.pull_request = {}; }, /workflow_dispatch/],
    ['make the version optional', (d) => { d.on.workflow_dispatch.inputs.codex_version.required = false; }, /required/],
    ['run on ubuntu', (d) => { d.jobs.proof['runs-on'] = 'ubuntu-latest'; }, /macos/],
    ['drop WE_TEST_SANDBOX', (d) => { delete stepNamed(d, /live sandbox proof/i).env.WE_TEST_SANDBOX; }, /WE_TEST_SANDBOX=0/],
    ['drop WE_CODEX_SANDBOX_TEST', (d) => { delete stepNamed(d, /live sandbox proof/i).env.WE_CODEX_SANDBOX_TEST; }, /WE_CODEX_SANDBOX_TEST=1/],
    ['unpin the CLI version', (d) => { const s = stepNamed(d, /install the exact codex/i); s.run = s.run.replace('@openai/codex@${CODEX_VERSION}', '@openai/codex@latest'); }, /pin/],
    ['interpolate the input into the script', (d) => { const s = stepNamed(d, /install the exact codex/i); s.run += '\necho ${{ inputs.codex_version }}\n'; }, /interpolated/],
    ['loosen the version check to a substring', (d) => { const s = stepNamed(d, /install the exact codex/i); s.run = s.run.replace('"${ACTUAL##* }" != "$CODEX_VERSION"', '"${ACTUAL}" != *"$CODEX_VERSION"*'); }, /exactly/],
    ['drop the version mismatch check', (d) => { const s = stepNamed(d, /install the exact codex/i); s.run = s.run.replace('does not match requested', 'ok'); }, /mismatch/],
    ['run the whole unit suite', (d) => { const s = stepNamed(d, /live sandbox proof/i); s.run = 'npx vitest run --reporter=json'; }, /exactly the named suites/],
    ['filter by test name', (d) => { const s = stepNamed(d, /live sandbox proof/i); s.run += ' -t 4443'; }, /filter/],
    ['continue on error', (d) => { stepNamed(d, /live sandbox proof/i)['continue-on-error'] = true; }, /continue-on-error/],
    ['swallow the proof failure', (d) => { stepNamed(d, /live sandbox proof/i).run += ' || true'; }, /swallows/],
    ['drop the pending check', (d) => { const s = stepNamed(d, /verify nothing was skipped/i); s.run = s.run.replace('.numPendingTests == 0', 'true'); }, /numPendingTests/],
    ['drop the per-case status check', (d) => { const s = stepNamed(d, /verify nothing was skipped/i); s.run = s.run.replace('.status != "passed"', '.status != "x"'); }, /status/],
    ['upload only on success', (d) => { delete d.jobs.proof.steps.find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact')).if; }, /always/],
  ];

  it.each(mutations)('rejects: %s', (_name, mutate, expected) => {
    const doc = clone();
    mutate(doc);
    const issues = workflowIssues(doc);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join('\n')).toMatch(expected);
  });
});

describe('4807 version validation is whole-string (real bash)', () => {
  const guard = /if ! (\[\[ "\$CODEX_VERSION" =~ .*? \]\]); then/.exec(stepNamed(load(raw), /install the exact codex/i).run)?.[1];
  const accepts = (version) => runChecked('bash', ['-c', `if ${guard}; then exit 0; else exit 1; fi`], { env: { PATH: process.env.PATH, CODEX_VERSION: version } }).status === 0;

  it('accepts exact versions', () => {
    expect(guard).toBeTruthy();
    for (const v of ['0.155.1', '1.2.3-rc.1', '10.20.30']) expect(accepts(v)).toBe(true);
  });
  it('rejects non-versions, including a multi-line value whose first line is valid', () => {
    for (const v of ['latest', '0.155', '0.155.1\nlatest', 'latest\n0.155.1', '0.155.1 ; rm -rf x', '0.155.1\n', '']) expect(accepts(v)).toBe(false);
  });
});

describe('4807 verify step rejects skipped or missing live cases (real jq)', () => {
  const doc = load(raw);
  const program = /jq -e --argjson min "\$LIVE_MIN_CASES" '\n([\s\S]*?)\n\s*' "\$EVIDENCE_DIR\/vitest-report\.json"/.exec(stepNamed(doc, /verify nothing was skipped/i).run)[1];
  const liveFile = '/w/scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs';
  const report = (statuses, extra = {}) => ({
    success: true, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: liveFile, assertionResults: statuses.map((status) => ({ status })) }], ...extra,
  });
  const verdict = (r, min = 6) => runChecked('jq', ['-e', '--argjson', 'min', String(min), program], { input: JSON.stringify(r) }).status;

  it('passes a fully-passed live suite of the demanded size', () => {
    expect(verdict(report(Array(6).fill('passed')))).toBe(0);
  });
  it('fails when every case was skipped even though vitest\'s counters say nothing is pending', () => {
    expect(verdict(report(Array(6).fill('skipped')))).not.toBe(0);
  });
  it('fails on one skipped case, a missing case, a failed case, or success:false', () => {
    expect(verdict(report([...Array(5).fill('passed'), 'skipped']))).not.toBe(0);
    expect(verdict(report(Array(5).fill('passed')))).not.toBe(0);
    expect(verdict(report([...Array(5).fill('passed'), 'failed'], { numFailedTests: 1, success: false }))).not.toBe(0);
    expect(verdict(report(Array(6).fill('passed'), { success: false }))).not.toBe(0);
  });
  it('fails when the live suite is absent from the report', () => {
    const r = report(Array(6).fill('passed'));
    r.testResults[0].name = '/w/other.test.mjs';
    expect(verdict(r)).not.toBe(0);
  });
});
