// @vitest-environment node
// R1068: soak shards run only in merge_group / push (main) / workflow_dispatch, never on pull_request. The behaviour of
// the `daemon-soak` aggregator script (passes on pull_request with no shards; fails closed in merge_group on a
// skipped/failed shard) is exercised in scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs; this file pins the
// workflow wiring that makes it true.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import unitConfig from '../../../vitest.config.ts';
import soakConfig from '../../../vitest.soak.config.ts';
import { shardFiles } from '../../conveyor/soak/shard-files.mjs';
import { computeSoakClosure } from '../../conveyor/soak/soak-scope.mjs';

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

// These imports are execution entries, not copied assertions: changes to the original
// files remain exercised by the normal soak discovery and required daemon-soak aggregate.
describe('slow real-git matrices retain merge-queue coverage', () => {
  it.each(['lane-pool-release-unpushed-guard', 'lane-pool-git-diet'])(
    '%s is excluded from PR units and assigned to exactly one required full-soak shard', name => {
      const original = `scripts/__tests__/${name}.test.mjs`;
      const entry = `scripts/conveyor/soak/breaks/${name}.soak.test.mjs`;
      expect(unitConfig.test.exclude).toContain(original);
      expect(computeSoakClosure().has(original)).toBe(true);
      expect(soakConfig.test.include).toContain('scripts/conveyor/soak/**/*.soak.test.mjs');
      expect(readFileSync(new URL(`../../../${entry}`, import.meta.url), 'utf8'))
        .toContain(`import '../../../__tests__/${name}.test.mjs';`);
      // The matrix is now a scope expression. These closure members select the full
      // eight-shard run; producer behaviour is exercised in soak-scope.test.mjs.
      expect(jobs['soak-shard'].strategy.matrix.shard)
        .toBe('${{ fromJSON(needs.daemon-soak-scope.outputs.shards) }}');
      const fullSoakShards = [1, 2, 3, 4, 5, 6, 7, 8];
      const assignments = fullSoakShards.flatMap(shard =>
        shardFiles({ shard, total: fullSoakShards.length }));
      expect(assignments.filter(file => file === entry)).toEqual([entry]);
      expect(jobs['soak-shard'].if).toMatch(/github\.event_name != 'pull_request'/);
      const command = jobs['soak-shard'].steps.find(step => step.run?.includes('npm run test:soak:shard'))?.run;
      expect(command).toContain('npm run test:soak:shard -- --shard=${{ matrix.shard }}/8');
      expect(jobs['daemon-soak'].needs).toContain('soak-shard');
      expect(jobs['daemon-soak'].if).toMatch(/merge_group/);
    },
  );
});
