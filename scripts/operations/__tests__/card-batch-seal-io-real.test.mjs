// @vitest-environment node
/**
 * @file scripts/operations/__tests__/card-batch-seal-io-real.test.mjs
 * @description Fidelity qualifier (#2949): actual ls-remote, admission, atomic journals, and successor refs
 * against a real bare origin through a narrow clone. Only GitHub and lane services are doubled.
 */
import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withNarrowClone } from './helpers/real-repo.mjs';
import { admitCard } from '../card-batch-io.mjs';
import { publishBatch, batchExec } from '../card-batch-seal-io.mjs';
import { findIoModulesWithoutFidelityTest } from '../../lib/operation-io-fidelity.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';

it('reads the remote head, seals red without promotion, and admits a successor without changing the sealed ref', async () => {
  await withNarrowClone(async ctx => {
    const stateDir = mkdtempSync(join(tmpdir(), 'seal-real-'));
    try {
      const baseSha = ctx.git(['rev-parse', 'HEAD']).trim();
      const lane = join(stateDir, 'lane');
      ctx.git(['clone', '--quiet', '--single-branch', '--branch', 'main', ctx.origin, lane]);
      mkdirSync(join(ctx.clone, 'backlog'), { recursive: true });
      writeFileSync(join(ctx.clone, 'backlog/5192-card.md'), '# Card\n');
      const input = { laneDir: ctx.clone, baseSha, kind: 'prevention', cardId: '5192', idemKey: 'one',
        cardPath: 'backlog/5192-card.md', source: { repo: 'org/repo', pr: 1 } };
      const admitted = await admitCard(input, { stateDir });
      const policy = loadCardBatchPolicy({ prevention: { maxCards: 1 } });
      const calls = [];
      const exec = (cmd, args, options) => {
        calls.push([cmd, ...args]);
        if (cmd === 'git') return batchExec(cmd, args, options);
        if (cmd === 'gh') return '';
        if (args[1] === 'acquire') return JSON.stringify({ path: lane, lane: 3, holder: 'test' });
        if (args[1] === 'verify') return JSON.stringify({ verdict: { ok: false, blocking: ['fixture red'] } });
        if (args[1] === 'open-pr') return JSON.stringify({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 10 } }] } } });
        return '';
      };
      expect((await publishBatch(input, { stateDir, policy, exec })).action).toBe('held');
      expect(ctx.git(['rev-parse', 'HEAD'], { cwd: lane }).trim()).toBe(admitted.state.headSha);
      expect(ctx.git(['rev-parse', 'HEAD']).trim()).toBe(baseSha);
      expect(calls.some(call => call.includes('ready'))).toBe(false);
      writeFileSync(join(ctx.clone, 'backlog/5193-card.md'), '# Next\n');
      const next = await admitCard({ ...input, cardId: '5193', idemKey: 'two', cardPath: 'backlog/5193-card.md' }, { stateDir });
      expect(next.batchRef).toBe('lane/card-batch-prevention-2');
      expect(ctx.git(['ls-remote', '--refs', 'origin', admitted.batchRef])).toContain(admitted.state.headSha);
      const archived = JSON.parse(readFileSync(join(stateDir, 'sealed/org-repo-1-prevention.json'), 'utf8'));
      expect(archived.sealFailure.reason).toContain('fixture red');
      // A forged local expected head refuses before any GitHub call.
      const path = join(stateDir, 'org-repo-prevention.json');
      writeFileSync(path, JSON.stringify({ ...next.state, headSha: baseSha }));
      calls.length = 0;
      expect(await publishBatch(input, { stateDir, policy, exec })).toEqual({ action: 'refuse', reason: 'head-mismatch' });
      expect(calls).toHaveLength(1);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
}, 30000);

it('satisfies the operation IO fidelity ratchet with a static, used real-repo harness import', () => {
  expect(findIoModulesWithoutFidelityTest({ ioModules: ['card-batch-seal'], allowlist: [], baseline: [],
    tests: [{ file: 'card-batch-seal-io-real.test.mjs', content: readFileSync(new URL(import.meta.url), 'utf8') }] }).errors).toEqual([]);
});
