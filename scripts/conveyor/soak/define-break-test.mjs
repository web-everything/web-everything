/**
 * @file define-break-test.mjs — #4075 daemon soak harness (card x0zg44l). One vitest test per real-world break
 * (`breaks/<id>.mjs`). Declared marker evidence always requires GREEN (missing evidence is an error).
 * When the tree under test carries a declared fixCommit, the scenario must be
 * GREEN. When it does not (the fix lives on another branch still in review), the test is EXPECTED-FAIL — titled
 * with the missing fix and its card, and `it.fails` still REQUIRES the break to reproduce, so it is never a
 * silent skip; it flips to a required pass by itself the moment the fix lands on this tree.
 * S1.1 keeps legacy function execution compatible while discovery warns; S1.2 migrates those descriptors
 * before removing this execution bridge. Declared sources always use the strict resolver below.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { validateFixPresent } from './breaks-shape.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

/** Read independent fix evidence. Missing/unreadable markers are hard failures. For a commit that is
 * not an ancestor, `git cherry` compares patch IDs (including rebased/cherry-picked fixes). Unknown
 * Git evidence is an error; the operator must restore the marker/module or the local commit history. */
export function resolveFixPresent(source, root) {
  validateFixPresent(source);
  if (source.marker) {
    const [file, name] = source.marker.split('#');
    let ast;
    try { ast = parse(readFileSync(resolve(root, file), 'utf8'), { sourceType: 'module', ecmaVersion: 2020 }); }
    catch { throw new Error(`soak: marker ${source.marker} missing or unreadable; restore the fix module`); }
    // Only an explicit local export declaration counts, never a comment/string or a re-export whose
    // target may have disappeared. Inspect syntax without running the module under test.
    const found = ast.body.some(node => node.type === 'ExportNamedDeclaration' && (
      node.declaration?.id?.name === name
      || node.declaration?.declarations?.some(declaration => declaration.id.name === name)
    ));
    if (!found) throw new Error(`soak: marker ${source.marker} missing; restore the fix module`);
    return true;
  }
  const git = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  try {
    const sha = git(['rev-parse', '--verify', `${source.fixCommit}^{commit}`]);
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid commit');
    try { git(['merge-base', '--is-ancestor', sha, 'HEAD']); return true; }
    catch (error) { if (error.status !== 1) throw error; }
    const equivalent = git(['cherry', 'HEAD', sha, `${sha}^`]);
    if (equivalent === `- ${sha}`) return true;
    if (equivalent === `+ ${sha}`) return false;
    throw new Error('incomplete patch-id evidence');
  } catch {
    throw new Error(`soak: fixCommit ${source.fixCommit} evidence unreadable; restore local commit history`);
  }
}

export function defineBreakTest(b, { root = REPO_ROOT } = {}) {
  // Temporary S1.1 bridge: rejecting legacy descriptors here would break collection of the unmigrated
  // registry. Discovery reports them without executing them; S1.2 owns their migration and this removal.
  const present = typeof b.fixPresent === 'function' ? b.fixPresent(root) : resolveFixPresent(b.fixPresent, root);
  const title = present
    ? `${b.title} — stays fixed (fix ${b.fixedBy.sha})`
    : `[EXPECTED-FAIL: fix ${b.fixedBy.sha} (${b.fixedBy.where}) is not in this tree — ${b.card}] ${b.title}`;
  describe(`daemon soak — break ${b.id}`, () => {
    (present ? it : it.fails)(title, async () => {
      const report = await b.run({});
      expect(b.judge(report)).toEqual([]);
    });
  });
}
