/**
 * @file skills-src/conveyor/__tests__/await-verify-briefs.test.mjs
 * @description Card 4 (opus perf sweep 2026-10-07): the delivery and prepare briefs hand the verify wait to the
 *   harness (`await-verify.mjs mark`, the way fixers do, #5137) instead of looping on `check --wait=`. Fails on a
 *   brief that still carries a `check --wait` command or is missing the `mark` line / the end-your-turn rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWAIT_VERIFY_KINDS } from '../../../scripts/conveyor/await-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fencedCommands = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)]
  .flatMap((m) => m[1].split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter(Boolean));

for (const [file, kind, marks] of [['delivery-agent-brief.md', 'delivery', 2], ['prepare-item-agent-brief.md', 'prepare', 1]]) {
  describe(`${file} — hands the verify wait to the harness`, () => {
    const text = readFileSync(join(HERE, '..', file), 'utf8');
    const cmds = fencedCommands(text);
    it('has no `check --wait` command left in any bash fence', () => {
      expect(cmds.filter((c) => /verify-lane\.mjs check\b.*--wait/.test(c))).toEqual([]);
    });
    it(`records the wait with await-verify mark --kind=${kind}, after each request`, () => {
      const marks_ = cmds.filter((c) => /await-verify\.mjs mark\b/.test(c));
      expect(marks_).toHaveLength(marks);
      for (const m of marks_) {
        expect(m).toContain(`--kind=${kind}`);
        expect(m).toMatch(/--item=\{\{ITEM_NUM\}\}/);
        expect(m).toMatch(/--who=\{\{SESSION_SLUG\}\}/);
        expect(m).toMatch(/--ref=lane\/\{\{ITEM_NUM\}\}/);
      }
      expect(AWAIT_VERIFY_KINDS).toContain(kind);
      expect(cmds.filter((c) => /verify-lane\.mjs request\b/.test(c))).toHaveLength(marks);
    });
    it('tells the agent to end its turn and never to loop or sleep', () => {
      const flat = text.replace(/\s+/g, ' ');
      expect(flat).toMatch(/end your turn/i);
      expect(flat).toMatch(/Never `check --wait`, never `sleep`/);
      expect(flat).toMatch(/\[harness verify verdict — #5137\]/);
    });
  });
}
