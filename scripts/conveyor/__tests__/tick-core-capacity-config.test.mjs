// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('tick-core IO shell maxConcurrentLanes boundary', () => {
  it.each([
    [50, 24], [24, 24], [1, 1],
    [0, 2], [-1, 2], [8.9, 2], ['24', 2], [null, 2], [{}, 2],
  ])('piped config %j admits at most %i lanes', (configured, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'tick-capacity-config-'));
    const preload = join(dir, 'ports.mjs');
    const state = {
      queue: [], lanes: [], prs: [],
      unshaped: Array.from({ length: 30 }, (_, i) => ({ num: i + 1 })),
    };
    // Execute the real shell with every subprocess replaced, including the host lane-pool read.
    writeFileSync(preload, `
      import cp from 'node:child_process';
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      const unavailable = () => { throw Error('unported fixture subprocess'); };
      cp.execFileSync = (cmd, args) => {
        if (cmd === 'node' && args[0].endsWith('/conveyor-state.mjs')) return ${JSON.stringify(JSON.stringify(state))};
        if (cmd === 'node' && args[0].endsWith('/dispatch-plan.mjs')) return '{"launch":[],"held":[]}';
        if (cmd === 'node' && args[0].endsWith('/lane-pool.mjs')) return JSON.stringify(Array.from({ length: 30 }, (_, i) => 'fixture/lane-' + (i + 1)));
        if (cmd === 'node' && args[0].endsWith('/heavy-admission.mjs')) return '{}';
        return unavailable();
      };
      cp.execFile = cp.spawn = cp.spawnSync = unavailable;
      os.homedir = () => ${JSON.stringify(dir)};
      os.userInfo = () => ({ homedir: ${JSON.stringify(dir)} });
      syncBuiltinESMExports();
    `);
    try {
      const output = execFileSync(process.execPath, [
        '--import', pathToFileURL(preload).href,
        resolve('scripts/conveyor/tick-core.mjs'), '--no-pause-check', `--backlog-dir=${dir}`,
      ], {
        input: JSON.stringify({ config: { maxConcurrentLanes: configured, verbose: false, costAdmission: { mode: 'off' } } }),
        encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, WE_MAX_CONCURRENT_LANES: '2', WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing.json') },
      });
      const { decisions } = JSON.parse(output);
      expect(decisions.spawnPrepareScope).toHaveLength(expected);
      expect(decisions.notes.some(n => n.kind === 'capacity-cap')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
