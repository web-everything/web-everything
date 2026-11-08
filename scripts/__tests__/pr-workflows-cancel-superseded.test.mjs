// PR workflows must cancel superseded runs without changing main's CI policy.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');
const selectWorkflowFiles = (names) => names.filter((name) => /\.ya?ml$/.test(name)).sort();
const workflowFiles = selectWorkflowFiles(readdirSync(workflowsDir));

// Pin the existing merge-gate exception: unwatched label events and non-PR/manual
// runs intentionally get unique keys. No other run-specific group is exempt.
const mergeGateGroup = "merge-gate-${{ (github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.event.label.name != 'ready-to-merge' && !startsWith(github.event.label.name, 'review:') && !startsWith(github.event.label.name, 'red-team:') && format('unwatched-{0}', github.run_id) || github.event.pull_request.number || github.event.merge_group.head_sha || github.run_id }}";

function prConcurrencyViolations(text) {
  // Parse once so aliases, merge keys, flow mappings and quoted scalars all have
  // the same meaning as YAML, rather than trusting a line-oriented approximation.
  let workflow;
  try {
    workflow = yaml.safeLoad(text);
  } catch {
    return ['invalid workflow YAML'];
  }
  const on = workflow?.on;
  if (!on) return ['missing top-level on'];
  const events = typeof on === 'string' ? [on]
    : Array.isArray(on) ? on : typeof on === 'object' ? Object.keys(on) : null;
  if (!events || !events.length || !events.every((event) => typeof event === 'string')) {
    return ['invalid top-level on'];
  }
  const hasPr = events.includes('pull_request');
  const hasTarget = events.includes('pull_request_target');
  if (!hasPr && !hasTarget) return [];

  const concurrency = workflow.concurrency;
  if (!concurrency) return ['missing top-level concurrency'];
  const group = concurrency.group;
  const cancel = concurrency['cancel-in-progress'];
  const violations = [];
  // Groups are global across workflows: require a workflow-specific literal
  // prefix ending in - or : before exactly one expression. Only bare keys
  // joined by || are allowed; a PR key must be first, before non-PR fallbacks.
  const expression = typeof group === 'string'
    ? group.match(/^[\w./:-]*[-:]\$\{\{\s*([^{}]+?)\s*\}\}$/) : null;
  const keys = expression?.[1].split('||').map((key) => key.trim()) ?? [];
  // Fork PRs can share head branch names, so github.head_ref is not a PR key.
  const prKeys = ['github.event.pull_request.number'];
  if (hasPr && !hasTarget) prKeys.push('github.ref');
  const allowedKeys = [...prKeys, 'github.event.merge_group.head_sha', 'github.run_id'];
  const allowedGroup = prKeys.includes(keys[0]) && keys.every((key) => allowedKeys.includes(key));
  if (group !== mergeGateGroup && !allowedGroup) {
    violations.push('concurrency group must include a PR-specific key');
  }
  // Fail closed on unknown expressions: this is the documented main exception.
  const mainException = hasPr && !hasTarget && cancel === "${{ github.ref != 'refs/heads/main' }}";
  if (cancel !== true && !mainException) {
    violations.push('cancel-in-progress must be true or the main-ref exception');
  }
  // Fail closed for push triggers, including implicit/all-branch and wildcard
  // filters: only PR-only workflows may unconditionally cancel runs.
  if (events.includes('push') && !mainException) {
    violations.push('main-push workflows must use the main-ref exception');
  }
  return violations;
}

const prFixture = 'on:\n  pull_request:\njobs: {}\n';
const concurrencyFixture = (group, cancel) => `${prFixture}concurrency:\n  group: ${group}\n  cancel-in-progress: ${cancel}\n`;

function expectDistinctPrPrefixes(workflows) {
  const owners = new Map();
  let prCount = 0;
  for (const [name, text] of workflows) {
    // Validate before extracting prefixes so malformed evidence cannot be skipped.
    expect(prConcurrencyViolations(text), name).toEqual([]);
    const workflow = yaml.safeLoad(text);
    const on = workflow.on;
    const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
    if (!events.includes('pull_request') && !events.includes('pull_request_target')) continue;
    prCount++;
    const prefix = workflow.concurrency.group.split('${{', 1)[0].toLowerCase();
    expect(owners.has(prefix), `${name} shares concurrency prefix "${prefix}" with ${owners.get(prefix)}`)
      .toBe(false);
    for (const [otherPrefix, owner] of owners) {
      expect(prefix.startsWith(otherPrefix) || otherPrefix.startsWith(prefix),
        `${name} concurrency prefix "${prefix}" overlaps "${otherPrefix}" from ${owner}`)
        .toBe(false);
    }
    owners.set(prefix, name);
  }
  expect(prCount, 'PR workflows checked for distinct concurrency prefixes').toBeGreaterThan(0);
}

describe('PR concurrency checker self-tests', () => {
  it.each(['pr', 'pr1', 'pr_', 'pr.', 'pr/'])(
    'rejects a literal prefix without a trailing - or : separator: %s', (prefix) => {
      expect(prConcurrencyViolations(concurrencyFixture(`${prefix}\${{ github.ref }}`, 'true')))
        .toContain('concurrency group must include a PR-specific key');
    },
  );

  it.each(['pr-', 'pr:'])(
    'accepts a literal prefix ending in a separator: %s', (prefix) => {
      expect(prConcurrencyViolations(concurrencyFixture(`${prefix}\${{ github.ref }}`, 'true')))
        .toEqual([]);
    },
  );

  it.each([
    ['pr-', 'pr-1-'], ['pr-1-', 'pr-'], ['pr:', 'pr:1:'], ['pr:1:', 'pr:'],
    ['ci-', 'CI-1-'], ['CI-1-', 'ci-'],
  ])(
    'rejects nested literal prefixes in either workflow order: %s then %s', (first, second) => {
      const fixtures = [
        ['first.yml', concurrencyFixture(`${first}\${{ github.ref }}`, 'true')],
        ['second.yaml', concurrencyFixture(`${second}\${{ github.event.pull_request.number }}`, 'true')
          .replace('pull_request:', 'pull_request_target:')],
      ];
      expect(() => expectDistinctPrPrefixes(fixtures))
        .toThrow(`second.yaml concurrency prefix "${second.toLowerCase()}" overlaps "${first.toLowerCase()}" from first.yml`);
    },
  );

  it.each([['shared-', 'shared-'], ['ci-', 'CI-']])(
    'rejects two PR workflows sharing a literal prefix despite different expressions: %s then %s', (first, second) => {
      const fixtures = [
        ['first.yml', concurrencyFixture(`${first}\${{ github.ref }}`, 'true')],
        ['second.yaml', concurrencyFixture(`${second}\${{ github.event.pull_request.number || github.run_id }}`, 'true')
          .replace('pull_request:', 'pull_request_target:')],
      ];
      expect(() => expectDistinctPrPrefixes(fixtures))
        .toThrow(`second.yaml shares concurrency prefix "${second.toLowerCase()}" with first.yml`);
    },
  );

  it('fails closed on malformed YAML when checking distinct PR prefixes', () => {
    expect(() => expectDistinctPrPrefixes([['invalid.yml', 'on: [pull_request']]))
      .toThrow('invalid workflow YAML');
  });

  it.each([
    "${{ github.ref && 'shared' }}",
    '${{ github.event.pull_request.number > 0 }}',
    '${{ github.event.pull_request.number == 1 }}',
    "pr-${{ github.head_ref || 'shared' }}",
    '${{ github.run_id || github.head_ref }}',
    '${{ github.head_ref || github.run_number }}',
    '${{ github.head_ref || }}',
  ])('rejects expressions outside the key-only fallback allowlist: %s', (group) => {
    expect(prConcurrencyViolations(concurrencyFixture(group, 'true')))
      .toContain('concurrency group must include a PR-specific key');
  });

  it.each(['pull_request_target', '[pull_request, pull_request_target]'])(
    'rejects github.ref and the main exception for %s', (events) => {
      const workflow = `on: ${events}\nconcurrency:\n  group: pr-\${{ github.ref }}\n  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}\n`;
      expect(prConcurrencyViolations(workflow)).toEqual([
        'concurrency group must include a PR-specific key',
        'cancel-in-progress must be true or the main-ref exception',
      ]);
    },
  );

  it.each(['github.event.pull_request.number'])(
    'accepts pull_request_target with plain true and %s', (key) => {
      const workflow = concurrencyFixture(`pr-\${{ ${key} }}`, 'true')
        .replace('pull_request:', 'pull_request_target:');
      expect(prConcurrencyViolations(workflow)).toEqual([]);
    },
  );

  it('accepts the exact merge-gate exception for pull_request_target', () => {
    expect(prConcurrencyViolations(concurrencyFixture(mergeGateGroup, 'true')
      .replace('pull_request:', 'pull_request_target:'))).toEqual([]);
  });

  it('rejects shared concurrency and false cancellation behind an aliased on', () => {
    const workflow = 'events: &events [pull_request]\non: *events\nconcurrency:\n  group: shared\n  cancel-in-progress: false\n';
    expect(prConcurrencyViolations(workflow)).toEqual([
      'concurrency group must include a PR-specific key',
      'cancel-in-progress must be true or the main-ref exception',
    ]);
  });

  it('resolves anchored trigger mappings and merged concurrency fields', () => {
    const workflow = `events: &events {pull_request: null}\npolicy: &policy\n  group: "pr-\${{ github.event.pull_request.number || github.run_id }}"\n  cancel-in-progress: true\non: *events\nconcurrency:\n  <<: *policy\n`;
    expect(prConcurrencyViolations(workflow)).toEqual([]);
  });

  it.each(['on: *undefined', 'on: [pull_request', 'on: pull_request\non: push'])(
    'fails closed on malformed YAML: %s', (workflow) => {
      expect(prConcurrencyViolations(workflow)).toEqual(['invalid workflow YAML']);
    },
  );

  it.each(['on: true', 'on: []', 'on: [null]'])(
    'fails closed on invalid trigger declarations: %s', (workflow) => {
      expect(prConcurrencyViolations(workflow)).toEqual(['invalid top-level on']);
    },
  );

  it.each(['github.run_id', 'github.run_number', 'github.sha'])(
    'rejects a run-specific suffix even alongside a PR key: %s', (key) => {
      expect(prConcurrencyViolations(concurrencyFixture(`pr-\${{ github.ref }}-\${{ ${key} }}`, 'true')))
        .toContain('concurrency group must include a PR-specific key');
    },
  );

  it.each(["${{ 'github.ref' }}", '${{ "github.head_ref" }}', "${{ 'github.event.pull_request.number' }}"])(
    'rejects a quoted literal masquerading as a PR key: %s', (group) => {
      expect(prConcurrencyViolations(concurrencyFixture(group, 'true')))
        .toContain('concurrency group must include a PR-specific key');
    },
  );

  it('rejects a quoted-literal expression even beside a real PR key', () => {
    expect(prConcurrencyViolations(concurrencyFixture("${{ github.ref }}-${{ 'github.ref' }}", 'true')))
      .toContain('concurrency group must include a PR-specific key');
  });

  it.each([
    mergeGateGroup,
    'soak-replay-gate-${{ github.event.pull_request.number || github.event.merge_group.head_sha }}',
    'pr-${{ github.event.pull_request.number || github.ref }}',
    'pr-${{github.event.pull_request.number||github.event.merge_group.head_sha||github.run_id}}',
  ])('accepts the existing PR and merge-group fallback form: %s', (group) => {
    expect(prConcurrencyViolations(concurrencyFixture(group, 'true'))).toEqual([]);
  });

  it.each(['pull_request', 'pull_request_target', '[pull_request, pull_request_target]'].flatMap(
    (events) => [
      'pr-${{ github.head_ref }}',
      'pr-${{ github.head_ref || github.run_id }}',
      'pr-${{ github.event.pull_request.number || github.head_ref }}',
    ].map((group) => [events, group]),
  ))(
    'rejects fork-ambiguous github.head_ref keys for %s: %s', (events, group) => {
      const workflow = concurrencyFixture(group, 'true')
        .replace('on:\n  pull_request:', `on: ${events}`);
      expect(prConcurrencyViolations(workflow))
        .toContain('concurrency group must include a PR-specific key');
    },
  );

  it.each([
    '${{ github.event.pull_request.number }}',
    '${{ github.ref }}',
    '${{ github.event.pull_request.number || github.run_id }}',
  ])('rejects a group without a workflow-specific literal prefix: %s', (group) => {
    expect(prConcurrencyViolations(concurrencyFixture(group, 'true')))
      .toContain('concurrency group must include a PR-specific key');
  });

  it('does not extend the merge-gate exception to a run-specific suffix', () => {
    expect(prConcurrencyViolations(concurrencyFixture(`${mergeGateGroup}-\${{ github.sha }}`, 'true')))
      .toContain('concurrency group must include a PR-specific key');
  });

  it('rejects plain true when PR and main-push triggers coexist', () => {
    const workflow = concurrencyFixture('pr-${{ github.ref }}', 'true')
      .replace('  pull_request:', '  push:\n    branches: [main]\n  pull_request:');
    expect(prConcurrencyViolations(workflow))
      .toContain('main-push workflows must use the main-ref exception');
  });

  it('scans a failing .yaml fixture while excluding disabled workflows', () => {
    const fixtures = {
      'bad.yaml': prFixture,
      'ok.yml': concurrencyFixture('pr-${{ github.ref }}', 'true'),
      'bad.yaml.disabled': prFixture,
      'bad.yml.disabled': prFixture,
      'notes.md': prFixture,
    };
    const files = selectWorkflowFiles(Object.keys(fixtures));
    expect(files).toEqual(['bad.yaml', 'ok.yml']);
    expect(files.flatMap((name) => prConcurrencyViolations(fixtures[name])))
      .toEqual(['missing top-level concurrency']);
  });

  it('reports a PR workflow without concurrency (red-first fixture)', () => {
    expect(prConcurrencyViolations(prFixture)).toEqual(['missing top-level concurrency']);
  });

  it.each(['github.event.pull_request.number', 'github.ref'])('accepts cancel true with %s', (key) => {
    expect(prConcurrencyViolations(concurrencyFixture(`pr-\${{ ${key} }}`, 'true'))).toEqual([]);
  });

  it('accepts the ci.yml main-ref exception', () => {
    const workflow = concurrencyFixture('ci-${{ github.ref }}', "${{ github.ref != 'refs/heads/main' }}")
      .replace('  pull_request:', '  push:\n    branches: [main]\n  pull_request:');
    expect(prConcurrencyViolations(workflow)).toEqual([]);
  });

  it.each(['false', '', '"true"', "${{ github.ref != 'refs/heads/release' }}", "${{ false && github.ref != 'refs/heads/main' }}"])(
    'rejects missing, false or unsupported cancellation: %s', (cancel) => {
      expect(prConcurrencyViolations(concurrencyFixture('pr-${{ github.ref }}', cancel)))
        .toContain('cancel-in-progress must be true or the main-ref exception');
    },
  );

  it.each(['shared', 'github.ref', '${{ github.ref_name }}', '${{ github.run_id }}'])(
    'rejects a group without a PR-specific expression: %s', (group) => {
      expect(prConcurrencyViolations(concurrencyFixture(group, 'true')))
        .toContain('concurrency group must include a PR-specific key');
    },
  );

  it.each(['on: [push, pull_request]', 'on: pull_request_target', '"on":\n  pull_request_target:'])(
    'detects PR triggers in %s', (trigger) => {
      expect(prConcurrencyViolations(`${trigger}\njobs: {}\n`)).toEqual(['missing top-level concurrency']);
    },
  );

  it('rejects job-level concurrency as a substitute for top-level concurrency', () => {
    expect(prConcurrencyViolations(`${prFixture.replace('jobs: {}', 'jobs:')}  test:\n    concurrency:\n      group: \${{ github.ref }}\n      cancel-in-progress: true`))
      .toEqual(['missing top-level concurrency']);
  });

  it('ignores comments claiming concurrency exists', () => {
    expect(prConcurrencyViolations(`${prFixture}# concurrency:\n#   group: \${{ github.ref }}\n#   cancel-in-progress: true`))
      .toEqual(['missing top-level concurrency']);
  });

  it('does not require merge_group-only workflows to cancel', () => {
    expect(prConcurrencyViolations('on:\n  merge_group:\nconcurrency:\n  group: merge\n  cancel-in-progress: false')).toEqual([]);
  });

  it('fails closed when the trigger declaration is missing', () => {
    expect(prConcurrencyViolations('jobs: {}')).toEqual(['missing top-level on']);
  });
});

describe('PR workflows cancel superseded runs', () => {
  it('uses prefix-free literal concurrency prefixes across all real PR workflows', () => {
    expectDistinctPrPrefixes(workflowFiles.map((name) => [
      name, readFileSync(join(workflowsDir, name), 'utf8'),
    ]));
  });

  it('finds workflow files to check', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)('%s has PR-specific concurrency and cancels superseded PR runs', (name) => {
    const text = readFileSync(join(workflowsDir, name), 'utf8');
    expect(prConcurrencyViolations(text), name).toEqual([]);
  });
});
