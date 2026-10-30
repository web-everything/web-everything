/**
 * @file resolve-parent-cli.test.mjs — CLI-level integration proof of the #2752 `resolve-parent` verb, on the
 * #2274 ephemeral-throwaway-clone substrate (copy the real scripts/ tree so backlog.mjs's own ROOT resolves
 * INSIDE the temp clone; run the REAL subprocess; assert exit code + JSON action + the actual epic file on
 * disk). Proves the WIRING the pure {@link planEpicResolveOnLand} core (unit-tested in epic-resolve.test.mjs)
 * can't: the child→parent edge read, the #658 parent-edge enumeration reuse, the resolved+graduatedTo=none
 * splice actually landing in the epic frontmatter (via the unguarded drain-side writer), and idempotency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// this file is scripts/backlog/__tests__/* → three levels up is .../scripts
const WE_SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let clone;
beforeAll(() => {
  clone = mkdtempSync(join(tmpdir(), 'we-resolve-parent-'));
  cpSync(WE_SCRIPTS_DIR, join(clone, 'scripts'), { recursive: true });
  cpSync(join(dirname(WE_SCRIPTS_DIR), 'skills-src/conveyor/daemon-manifest.mjs'),
    join(clone, 'skills-src/conveyor/daemon-manifest.mjs'));
  // The transcript check imports this skill module during CLI startup.
  cpSync(join(dirname(WE_SCRIPTS_DIR), 'skills-src', 'inspect-codex-transcript'),
    join(clone, 'skills-src', 'inspect-codex-transcript'), { recursive: true });
  symlinkSync(join(dirname(WE_SCRIPTS_DIR), 'node_modules'), join(clone, 'node_modules'), 'dir');
  mkdirSync(join(clone, '.claude', 'skills', 'batch-backlog-items'), { recursive: true });
  mkdirSync(join(clone, 'backlog'), { recursive: true });
});
afterAll(() => { try { rmSync(clone, { recursive: true, force: true }); } catch { /* best-effort */ } });

const BACKLOG_MJS = () => join(clone, 'scripts', 'backlog.mjs');
const write = (rel, content) => writeFileSync(join(clone, 'backlog', rel), content);
const read = (rel) => readFileSync(join(clone, 'backlog', rel), 'utf8');
const item = (fields, body = '# Title\n\nPlain body, no code refs.\n') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;

function run(args) {
  try {
    const stdout = execFileSync('node', [BACKLOG_MJS(), ...args, '--json'], { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (e) {
    let json; try { json = JSON.parse(e.stdout); } catch { /* non-JSON */ }
    return { code: typeof e.status === 'number' ? e.status : 1, json, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('backlog.mjs resolve-parent — the on-land epic close (#2752)', () => {
  it('last child resolved → resolves the parent epic (status resolved + graduatedTo none)', () => {
    write('8100-epic.md', item({ kind: 'epic', size: 3, status: 'open', dateOpened: '"2026-07-01"' }));
    write('8101-child.md', item({ kind: 'story', size: 2, status: 'resolved', parent: '"8100"', dateOpened: '"2026-07-01"' }));
    const res = run(['resolve-parent', '8101']);
    expect(res.code).toBe(0);
    expect(res.json.ok).toBe(true);
    expect(res.json.action).toBe('resolved');
    expect(res.json.epic).toBe('8100-epic');
    const epicAfter = read('8100-epic.md');
    expect(epicAfter).toMatch(/^status: resolved$/m);
    expect(epicAfter).toMatch(/^graduatedTo: none$/m);
  });

  it('idempotent — a second call after the epic is already resolved is a no-op skip', () => {
    const res = run(['resolve-parent', '8101']);
    expect(res.code).toBe(0);
    expect(res.json.action).toBe('skip');
    expect(res.json.reason).toBe('already-resolved');
  });

  it('NOT the last child — a sibling still open → skip, epic left untouched', () => {
    write('8200-epic.md', item({ kind: 'epic', size: 3, status: 'open', dateOpened: '"2026-07-01"' }));
    write('8201-child.md', item({ kind: 'story', size: 2, status: 'resolved', parent: '"8200"', dateOpened: '"2026-07-01"' }));
    write('8202-child.md', item({ kind: 'story', size: 2, status: 'open', parent: '"8200"', dateOpened: '"2026-07-01"' }));
    const res = run(['resolve-parent', '8201']);
    expect(res.json.action).toBe('skip');
    expect(res.json.reason).toBe('open-children');
    expect(read('8200-epic.md')).toMatch(/^status: open$/m);
  });

  it('a blocked epic whose last child landed → ESCALATE, never auto-closed', () => {
    write('8300-epic.md', item({ kind: 'epic', size: 3, status: 'open', blockedBy: '["8999"]', childlessReason: 'blocked', dateOpened: '"2026-07-01"' }));
    write('8301-child.md', item({ kind: 'story', size: 2, status: 'resolved', parent: '"8300"', dateOpened: '"2026-07-01"' }));
    const res = run(['resolve-parent', '8301']);
    expect(res.json.action).toBe('escalate');
    expect(res.json.reason).toBe('blocked-by');
    expect(read('8300-epic.md')).toMatch(/^status: open$/m);
  });

  it('a child with no parent edge → skip no-parent', () => {
    write('8400-orphan.md', item({ kind: 'story', size: 2, status: 'resolved', dateOpened: '"2026-07-01"' }));
    const res = run(['resolve-parent', '8400']);
    expect(res.json.action).toBe('skip');
    expect(res.json.reason).toBe('no-parent');
  });

  it('parent is a story (not an epic) → skip parent-not-epic, never closes a non-epic', () => {
    write('8500-parent-story.md', item({ kind: 'story', size: 5, status: 'open', dateOpened: '"2026-07-01"' }));
    write('8501-child.md', item({ kind: 'story', size: 2, status: 'resolved', parent: '"8500"', dateOpened: '"2026-07-01"' }));
    const res = run(['resolve-parent', '8501']);
    expect(res.json.action).toBe('skip');
    expect(res.json.reason).toBe('parent-not-epic');
    expect(read('8500-parent-story.md')).toMatch(/^status: open$/m);
  });
});
