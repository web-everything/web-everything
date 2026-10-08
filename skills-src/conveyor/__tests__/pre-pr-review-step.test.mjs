/**
 * @file skills-src/conveyor/__tests__/pre-pr-review-step.test.mjs
 * @description xcbwt4r — the pre-PR review must be the NORMAL path. Overnight every risky PR opened without a
 *   receipt because the briefs never told the agent to run the review. Each of the delivery, fix and ci-heal
 *   briefs must carry the step: ask `pre-pr-check`, and when gated run the converge receipt flow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEFS = ['delivery-agent-brief.md', 'fix-agent-brief.md', 'fix-agent-ci-brief.md'];

for (const file of BRIEFS) {
  describe(`${file} — pre-PR review step`, () => {
    const text = readFileSync(join(HERE, '..', file), 'utf8');
    const fences = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');

    it('runs the pre-pr-check helper against the lane in a bash fence', () => {
      expect(fences).toMatch(/operations\/run\.mjs"? pre-pr-check --checkout="\$LANE"/);
    });

    it('names the converge receipt flow that produces the receipt', () => {
      expect(text).toMatch(/converge-cli\.mjs"? init/);
      expect(text).toMatch(/converge-cli\.mjs"? receipt --lane="\$LANE" --state=/);
    });

    it('ties the review to the gated verdict', () => {
      expect(text).toMatch(/pre-pr-check: gated/);
    });
  });
}
