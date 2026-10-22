// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainRequestRedTeam } from '../merge-ai-prs.mjs';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');

describe('merge-ai-prs wires the drain red-team re-request (card 6267)', () => {
  it('every createDrainMergeStrategy call site passes requestRedTeam', () => {
    const sites = [...SRC.matchAll(/createDrainMergeStrategy\(\{([^\n]*)\}\)/g)].map(m => m[1]);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const args of sites) expect(args).toContain('requestRedTeam: drainRequestRedTeam({ dryRun: DRY_RUN })');
  });
  it('the hook forwards the exact head to the request writer with a reason; a dry run posts nothing', () => {
    const seen = [];
    const hook = drainRequestRedTeam({ request: i => { seen.push(i); return { requested: true }; } });
    expect(hook({ repo: 'o/r', pr: 1, head: 'a'.repeat(40), loopPayload: {} })).toEqual({ requested: true });
    expect(seen[0]).toMatchObject({ repo: 'o/r', pr: 1, head: 'a'.repeat(40), reason: expect.stringContaining('drain') });
    expect(drainRequestRedTeam({ dryRun: true })).toBeNull();
  });
});
