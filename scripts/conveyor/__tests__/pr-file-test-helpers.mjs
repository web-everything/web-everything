/** Shared behavioral contract, registered in each consumer's own suite. All subprocesses are mocked. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readPrsFromFile } from '../open-pr-fetch.mjs';

const fixture = [901, 902].map((number) => ({
  number, headRefName: `lane/3478-delivery-${number}`, headRefOid: `sha-${number}`,
  title: 'WE #3478: implement delivery', body: 'Closes #3478', labels: [{ name: 'review:pending' }],
  files: [{ path: 'scripts/example.mjs' }], mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
  statusCheckRollup: [], comments: [],
}));

export function prFileContract({ name, load, reader, run, fields, reconcile = false, progress = false }) {
  describe(`${name} PR snapshot IO`, () => {
    async function withFile(fn) {
      const dir = mkdtempSync(join(tmpdir(), 'conveyor-pr-file-test-'));
      const path = join(dir, 'snapshot with spaces.json');
      try { return await fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
    }

    it('preserves nonempty decisions from the same fixture through the file reader override', async () => {
      await withFile(async (path) => {
        const mod = await load();
        writeFileSync(path, JSON.stringify(fixture));
        const options = {
          repo: 'web-everything/web-everything', dryRun: true, now: Date.parse('2026-09-18T12:00:00Z'),
          listAgents: () => [], readAgents: () => [], enrich: (agents) => agents,
          listLabelEvents: () => [{ createdAt: '2026-09-15T12:00:00Z', labelName: 'review:pending' }],
        };
        const key = reconcile ? 'readPrs' : 'listPrs';
        const expected = mod[run]({ ...options, [key]: () => fixture });
        const actual = mod[run]({ ...options, [key]: () => readPrsFromFile(path) });
        expect(actual).toEqual(expected);
        expect(reconcile ? actual.dispatch.length + actual.refusals.length : actual.length).toBeGreaterThan(0);
      });
    });

    it('the default reader uses execFileSyncThrottled and preserves its exact standalone argv', async () => {
      const mod = await load();
      const { execFileSync } = await import('node:child_process');
      const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
      execFileSync.mockReset().mockReturnValue(JSON.stringify(fixture));
      execFileSyncThrottled.mockClear();
      expect(mod[reader]({ repo: 'owner/repo' })).toEqual(fixture);
      expect(execFileSyncThrottled).toHaveBeenCalledTimes(1);
      expect(execFileSyncThrottled).toHaveBeenCalledWith('gh',
        ['pr', 'list', '--state', 'open', '--limit', '200', '--json', fields, '--repo', 'owner/repo'], expect.any(Object));
      execFileSyncThrottled.mockClear();
      mod[reader]();
      expect(execFileSyncThrottled).toHaveBeenCalledTimes(1);
      expect(execFileSyncThrottled).toHaveBeenCalledWith('gh',
        ['pr', 'list', '--state', 'open', '--limit', '200', '--json', fields], expect.any(Object));
    });

    async function cli(args, prs) {
      vi.resetModules();
      const { execFileSync } = await import('node:child_process');
      const { writeAllSync } = await import('../../lib/write-all-sync.mjs');
      const { execFileSyncThrottled } = await import('../../lib/gh-throttle.mjs');
      execFileSync.mockReset().mockImplementation((cmd, argv) => {
        if (cmd === 'gh' && argv[0] === 'pr' && argv[1] === 'list') return JSON.stringify(prs);
        if (cmd === 'claude') return '[]';
        throw new Error(`Unexpected subprocess: ${cmd} ${argv.join(' ')}`);
      });
      execFileSyncThrottled.mockClear();
      writeAllSync.mockClear();
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const savedArgv = process.argv;
      const savedExitCode = process.exitCode;
      try {
        process.argv = [process.execPath, resolve(`scripts/conveyor/${name}.mjs`),
          ...(reconcile ? ['--json'] : ['sweep', '--dry-run']), '--repo=web-everything/web-everything', ...args];
        await load(); // Executes the actual IS_CLI block, including flag parsing.
        expect(process.exitCode).toBe(savedExitCode);
        const output = reconcile ? stdout.mock.calls.map(([s]) => s).join('')
          : writeAllSync.mock.calls.filter(([fd]) => fd === 1).map(([, s]) => s).join('');
        return { result: JSON.parse(output), calls: [...execFileSync.mock.calls], throttled: [...execFileSyncThrottled.mock.calls] };
      } finally {
        process.argv = savedArgv;
        process.exitCode = savedExitCode;
        stdout.mockRestore();
      }
    }

    it('--prs-file is parsed by the CLI, bypasses gh, and preserves its JSON output', async () => {
      await withFile(async (path) => {
        // Progress candidates deliberately require a separate gh timeline read, out of scope here.
        // Use its dedup branch for zero-gh CLI proof; candidate fidelity is exercised above.
        const prs = progress ? fixture.map((pr) => ({ ...pr, labels: [{ name: 'review:changes' }] })) : fixture;
        writeFileSync(path, JSON.stringify(prs));
        const agentsPath = `${path}.agents.json`;
        const agentsArgs = reconcile ? [`--agents-file=${agentsPath}`] : [];
        if (reconcile) writeFileSync(agentsPath, '[]');
        const fromFile = await cli([...agentsArgs, `--prs-file=${path}`], prs);
        expect(fromFile.calls.filter(([cmd]) => cmd === 'gh')).toEqual([]);
        expect(fromFile.throttled).toEqual([]);
        const standalone = await cli(agentsArgs, prs);
        if (reconcile) {
          expect(fromFile.calls.filter(([cmd]) => cmd === 'claude')).toEqual([]);
          expect(standalone.calls.filter(([cmd]) => cmd === 'claude')).toEqual([]);
        }
        expect(standalone.result).toEqual(fromFile.result);
        expect(standalone.throttled).toEqual([['gh',
          ['pr', 'list', '--state', 'open', '--limit', '200', '--json', fields, '--repo', 'web-everything/web-everything'], expect.any(Object)]]);
      });
    });
  });
}
