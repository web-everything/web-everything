// @vitest-environment node
// @repo-scanning-test scope=files — CI and deploy workflow source contracts.
// R1068: soak shards run only in merge_group / push (main) / workflow_dispatch, never on pull_request. The behaviour of
// the `daemon-soak` aggregator script (passes on pull_request with no shards; fails closed in merge_group on a
// skipped/failed shard) is exercised in scripts/conveyor/soak/__tests__/daemon-soak-gate.test.mjs; this file pins the
// workflow wiring that makes it true.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import yaml from 'js-yaml';
import unitConfig from '../../../vitest.config.ts';
import soakConfig from '../../../vitest.soak.config.ts';
import { shardFiles } from '../../conveyor/soak/shard-files.mjs';
import { computeSoakClosure } from '../../conveyor/soak/soak-scope.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopedScanFiles } from '../../lib/repo-scan-tests.mjs';
import { spawnSync } from 'node:child_process';

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

// Discover the governed workflows in the checkout, then scope them by the manifest.
// Source imports are code under test. All runtime files and IO live in a temporary fixture.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const workflowPaths = ['.github/workflows/ci.yml', '.github/workflows/deploy.yml'];
const discoveredWorkflows = readdirSync(join(ROOT, '.github/workflows'))
  .map(name => `.github/workflows/${name}`)
  .filter(path => workflowPaths.includes(path));
// Missing governed inputs must fail even when the changed-file scope excludes them.
expect(discoveredWorkflows.sort()).toEqual([...workflowPaths].sort());
for (const path of scopedScanFiles(discoveredWorkflows)) {
  describe(`SOAK-POSTMERGE workflow contract: ${path}`, () => {
    it('retains fast premerge checks and a mandatory exact-head postmerge hold at the consumer', async () => {
      const root = mkdtempSync(join(tmpdir(), 'postmerge-workflow-'));
      try {
        const fixture = join(root, 'workflow.yml');
        // These are data assets, loaded through Vite's raw loader. Vitest 1's related graph
        // drops query strings on static asset imports and then parses YAML as JavaScript.
        // The scoped scanner manifest owns discovery for these two non-code inputs.
        const source = await import(new URL(`../../../${path}?raw`, import.meta.url).href);
        writeFileSync(fixture, source.default);
        const workflow = yaml.load(readFileSync(fixture, 'utf8'));
        if (path.endsWith('/ci.yml')) {
          const scope = workflow.jobs['daemon-soak-scope'];
          expect(scope.outputs.phase).toBe('${{ steps.phase.outputs.phase }}');
          const shard = workflow.jobs['soak-shard'];
          expect(shard.steps.find(step => step.name?.startsWith('Soak shard ')).if)
            .toBe("needs.daemon-soak-scope.outputs.phase == 'postmerge'");
          expect(shard.steps.find(step => step.name === 'Install').if)
            .toBe("needs.daemon-soak-scope.outputs.phase == 'postmerge'");
          expect(shard.steps.find(step => step.name === 'Premerge scope safeguards').if)
            .toBe("needs.daemon-soak-scope.outputs.phase == 'premerge'");
          const receipt = workflow.jobs['postmerge-soak-v1'];
          expect(receipt.needs).toEqual(['daemon-soak-scope', 'soak-shard', 'daemon-soak']);
          expect(receipt.if).toContain("always() && github.event_name == 'push' && github.ref == 'refs/heads/main'");
          expect(receipt['timeout-minutes']).toBe(5);
          expect(receipt.steps.at(-1).run).toBe('node scripts/conveyor/soak/soak-scope.mjs --postmerge-receipt');
        } else {
          expect(workflow.concurrency).toEqual({ group: 'deploy-worker', 'cancel-in-progress': false });
          const steps = workflow.jobs.deploy.steps;
          const guards = steps.filter(step => step.name?.match(/postmerge.*(hold|deployment)/));
          expect(guards).toHaveLength(2);
          expect(steps.indexOf(guards[0])).toBeLessThan(steps.findIndex(step => step.name === 'Build FUI tools'));
          expect(steps.indexOf(guards[1]) + 1).toBe(steps.findIndex(step => step.name === 'Deploy Worker + assets'));
          const moduleDir = join(root, 'web-everything/scripts/conveyor/soak');
          mkdirSync(moduleDir, { recursive: true });
          writeFileSync(join(moduleDir, 'soak-scope.mjs'),
            'export async function postmergeReleaseGate(input) { return input.request("fixture", { repo: input.repo, sha: input.sha, now: input.now() }); }');
          for (const guard of guards) {
            expect(guard.with['github-token']).toBe('${{ github.token }}');
            expect(guard.with.retries).toBe(0);
            for (const ok of [false, true]) {
              // Native ESM exercises the actual dynamic import used by github-script.
              const entry = join(root, 'guard.mjs');
              writeFileSync(entry, `import { stdout } from 'node:process';
                const process = { env: ${JSON.stringify({ GITHUB_WORKSPACE: root, DEPLOY_SHA: 'a'.repeat(40) })} };
                const failures = [], requests = [];
                const context = { repo: { owner: 'fixture', repo: 'project' } };
                const github = { request: async (route, args) => { requests.push({ route, args }); return {
                  ok: ${ok}, reason: 'fixture-held', owner: 'repository-maintainers', recovery: 'rerun once' }; } };
                const core = { info() {}, setFailed(message) { failures.push(message); } };
                const Date = { now: () => 1000 };
                await (async () => { ${guard.with.script} })();
                stdout.write(JSON.stringify({ failures, requests }));`);
              const result = spawnSync(process.execPath, [entry], { cwd: root,
                env: { HOME: root, TMPDIR: root }, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
              expect(result.error).toBeUndefined();
              expect(result.status, result.stderr).toBe(0);
              const { requests, failures } = JSON.parse(result.stdout);
              expect(requests).toEqual([{ route: 'fixture', args: { repo: 'fixture/project', sha: 'a'.repeat(40), now: 1000 } }]);
              expect(failures).toHaveLength(ok ? 0 : 1);
              if (!ok) expect(failures[0]).toContain('Release held: fixture-held');
            }
          }
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });
}

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
