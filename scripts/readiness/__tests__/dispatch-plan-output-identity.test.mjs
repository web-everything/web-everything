/**
 * 78c — the plan the dispatch-plan CLI emits is byte-identical (observation fields aside) to the plan the
 * sequential implementation emitted for the same fixture. The golden was captured from the code BEFORE the
 * reads were started concurrently; set UPDATE_GOLDEN=1 only for an intended decision change.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const PLAN_CLI = join(ROOT, 'scripts', 'readiness', 'dispatch-plan.mjs');
const GOLDEN = join(HERE, 'fixtures', 'dispatch-plan-output-identity.golden.json');

function writeItem(dir, filename, frontmatter, title) {
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n\n# ${title}\n`, 'utf8');
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-plan-identity-'));
  const backlogDir = join(root, 'backlog');
  mkdirSync(backlogDir, { recursive: true });
  const cleared = [];
  const add = (num, fm, title) => {
    writeItem(backlogDir, `${num}-fixture-${num}.md`, { bornAs: `x${num}fix`, status: 'open', dateOpened: '2020-01-01', tags: [], ...fm }, title);
    cleared.push({ num, addedAt: '2026-01-01T00:00:00.000Z' });
  };
  add('8001', { kind: 'story', size: 1, scope: ['we:scripts/a.mjs'], preparedDate: '2026-10-01' }, 'Ready A');
  add('8002', { kind: 'story', size: 1, scope: ['we:scripts/a.mjs'], preparedDate: '2026-10-01' }, 'Overlaps A');
  add('8003', { kind: 'story', size: 1, scope: ['we:scripts/c.mjs'], preparedDate: '2026-10-01' }, 'Ready C');
  add('8004', { kind: 'story', size: 1, scope: ['we:scripts/d.mjs'] }, 'Unprepared');
  add('8005', { kind: 'story', size: 1 }, 'Unscoped');
  add('8006', { kind: 'epic', size: 8, scope: ['we:scripts/e.mjs'] }, 'Epic');
  add('8007', { kind: 'story', size: 1, scope: ['we:scripts/f.mjs'], blockedBy: ['9999'] }, 'Blocked');
  writeFileSync(join(root, 'queue.json'), JSON.stringify(cleared), 'utf8');
  return { root, backlogDir, queueFile: join(root, 'queue.json') };
}

describe('dispatch-plan output identity (78c)', () => {
  it('emits the same plan as the sequential implementation (timings excluded)', () => {
    const f = buildFixture();
    try {
      const out = JSON.parse(execFileSync('node', [PLAN_CLI, '--json', `--backlog-dir=${f.backlogDir}`, '--free-lanes=1,2,3',
        '--no-ground-truth', '--no-drift-check', '--no-pause-check', '--no-pr-limit-check', '--no-size-check'], {
        cwd: ROOT, timeout: 60000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CONVEYOR_QUEUE_FILE: f.queueFile },
      }));
      if (!process.env.UPDATE_GOLDEN) expect(typeof out.timings).toBe('object'); // the new observation field
      delete out.timings;
      if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(out, null, 2) + '\n');
      expect(out).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
      expect(out.launch.length + out.held.length).toBeGreaterThan(3);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
