// @vitest-environment node
// R1068: soak shards run only in merge_group / push (main) / workflow_dispatch, never on pull_request. The behaviour of
// the `daemon-soak` aggregator script (passes on pull_request with no shards; fails closed in merge_group on a
// skipped/failed shard) is exercised in scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs; this file pins the
// workflow wiring that makes it true.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const { jobs } = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));

describe('ci.yml soak runs in the merge queue only (R1068)', () => {
  it('soak-shard is excluded on pull_request', () => {
    expect(jobs['soak-shard'].if).toMatch(/github\.event_name != 'pull_request'/);
  });

  it('daemon-soak keeps its name, still needs the shards, and still fires on merge_group', () => {
    expect(jobs['daemon-soak'].needs).toContain('soak-shard');
    expect(jobs['daemon-soak'].if).toMatch(/merge_group/);
    expect(jobs['daemon-soak'].if).toMatch(/pull_request/);
  });

  it('the aggregator short-circuits green only for pull_request', () => {
    const script = jobs['daemon-soak'].steps.find((s) => s.name === 'Gate on shard results').run;
    expect(script).toMatch(/github\.event_name \}\}" = "pull_request"/);
    expect(script).toMatch(/soak deferred to merge queue \(R1068\)/);
  });
});
