// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gate from '../red-team-gate.mjs';
import { formatCascadeSourcesLine } from '../policy-cascade.mjs';

// #6212: these new readers deliberately define the same return shape as readRedTeamProbes.
// Namespace imports keep a missing export a named assertion failure, not a collection failure.
describe('redTeam.timing policy cascade', () => {
  const resolve = options => {
    expect(gate.resolveRedTeamTiming, 'export the pure timing cascade reader').toBeTypeOf('function');
    return gate.resolveRedTeamTiming(options);
  };

  it('defaults to panel-seat from standard', () => {
    expect(resolve({ file: {}, platform: {}, env: {} })).toMatchObject({
      value: { timing: 'panel-seat' }, sources: { timing: 'standard' }, invalid: [],
    });
  });

  it('resolves standard < platform < tool < environment independently', () => {
    const options = { file: {}, platform: { timing: 'post-accept' }, env: {} };
    expect(resolve(options)).toMatchObject({ value: { timing: 'post-accept' }, sources: { timing: 'platform' } });
    options.file = { redTeam: { timing: 'panel-seat' } };
    expect(resolve(options)).toMatchObject({ value: { timing: 'panel-seat' }, sources: { timing: 'tool' } });
    options.env.WE_RED_TEAM_TIMING = 'post-accept';
    expect(resolve(options)).toMatchObject({ value: { timing: 'post-accept' }, sources: { timing: 'env' } });
  });

  it('ignores and names invalid values at every layer', () => {
    expect(resolve({ file: { redTeam: { timing: 'later' } }, platform: { timing: false },
      env: { WE_RED_TEAM_TIMING: 'sometimes' } })).toMatchObject({
      value: { timing: 'panel-seat' }, sources: { timing: 'standard' },
      invalid: ['platform.timing=false', 'tool.timing="later"', 'env.timing="sometimes"'],
    });
    expect(resolve({ file: {}, platform: { timing: 'post-accept' }, env: { WE_RED_TEAM_TIMING: 'bad' } }))
      .toMatchObject({ value: { timing: 'post-accept' }, sources: { timing: 'platform' } });
  });

  it('reads real settings files and logs the winning source with formatCascadeSourcesLine', () => {
    expect(gate.readRedTeamTiming, 'export the IO timing cascade reader').toBeTypeOf('function');
    const root = mkdtempSync(join(tmpdir(), 'red-team-timing-'));
    try {
      const path = join(root, 'tool.json'), platformPath = join(root, 'platform.json');
      writeFileSync(path, JSON.stringify({ redTeam: { timing: 'panel-seat' } }));
      writeFileSync(platformPath, JSON.stringify({ redTeam: { timing: 'post-accept' } }));
      const lines = [];
      const result = gate.readRedTeamTiming({ path,
        env: { WE_PLATFORM_PREFERENCES_FILE: platformPath, WE_RED_TEAM_TIMING: 'post-accept' },
        log: line => lines.push(line) });
      expect(result).toMatchObject({ value: { timing: 'post-accept' }, sources: { timing: 'env' } });
      expect(lines).toContain(formatCascadeSourcesLine('redTeam', result));
      expect(lines.join('\n')).toContain('timing="post-accept" (env)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
