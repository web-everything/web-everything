/**
 * @file Real filesystem refusal persistence, kept in a focused fidelity proof.
 * The operation IO gate must recognize the harness call as well as the module import.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createPrototypeLoader, defaultDeps } from '../prototype-load-io.mjs';

describe('prototype-load real IO', () => {
  it('refuses missing readiness evidence and persists the refusal on a real filesystem', async () => {
    await withRealRepo(async ({ root, head }) => {
      const input = { branch: 'lane/new', sha: head(), daemon: 'control' };
      const recordPath = join(root, 'audit', 'prototype-load.jsonl');
      const load = createPrototypeLoader({ ...defaultDeps(),
        env: { HOME: root },
        settings: {
          daemons: { control: { clone: root } }, workspaceRoot: root,
          recordPath, readyRecordPath: join(root, 'missing-ready.jsonl'),
          adoption: { timeoutMs: 30, pollMs: 10 },
        },
      });
      const result = await load(input);
      expect(result).toMatchObject({ ok: false, stopReason: 'no-ready', registered: false, adopted: false });
      const records = readFileSync(recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ ...input, ok: false, stopReason: 'no-ready', registered: false, adopted: false });
    });
  });
});
