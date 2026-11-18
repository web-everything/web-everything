import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveOperation } from '../run.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createGenesisRunner } from '../audit-ledger-genesis.mjs';

let root, path;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'genesis-op-')); path = join(root, 'audits.jsonl'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('registers --apply with a false default and prints a dry-run plan without touching the ledger', async () => {
  const binding = resolveOperation('audit-ledger-genesis');
  expect(binding.declaration.input.apply.default).toBe(false);
  const invoke = async argv => {
    const outcome = await runOperationCli({ ...binding, argv, store: createMemoryRunStore(),
      newRunId: () => 'genesis-test', sinks: { 'audit-ledger-genesis.run': createGenesisRunner({ path }) } });
    return binding.finish(outcome);
  };
  const dry = await invoke([]);
  expect(dry.code).toBe(0);
  expect(JSON.parse(dry.lines.join(''))).toMatchObject({ legacyCount: 0, genesisExists: false, wouldAppend: true, applied: false });
  expect(fs.readdirSync(root)).toEqual([]);
  const raw = ' {"verdict":"WEAKENED"}\r\n\n';
  fs.writeFileSync(path, raw);
  const applied = await invoke(['--apply']);
  expect(applied.code).toBe(0);
  expect(JSON.parse(applied.lines.join(''))).toMatchObject({ applied: true, genesisExists: true });
  const bytes = fs.readFileSync(path);
  const again = await invoke(['--apply']);
  expect(JSON.parse(again.lines.join(''))).toMatchObject({ applied: false, genesisExists: true, wouldAppend: false,
    legacyCount: 1, legacyDigest: createHash('sha256').update(raw).digest('hex') });
  expect(fs.readFileSync(path)).toEqual(bytes);
});
