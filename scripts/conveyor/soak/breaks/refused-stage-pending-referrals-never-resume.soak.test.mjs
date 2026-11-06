import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import b from './refused-stage-pending-referrals-never-resume.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('reproduces the cached-pending stageVerdict refusal on the committed fix parent', () => {
  const root = resolve(fileURLToPath(import.meta.url), '../../../../..');
  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'refused-stage-parent-'));
  try {
    cpSync(join(root, 'scripts'), join(scratch, 'scripts'), {
      recursive: true, filter: path => !['__tests__', 'soak', 'node_modules'].includes(basename(path)),
    });
    for (const name of ['node_modules', 'src', 'schemas', 'docs', 'skills-src', 'package.json']) {
      if (existsSync(join(root, name))) symlinkSync(join(root, name), join(scratch, name));
    }
    for (const path of b.fixedBy.paths) {
      writeFileSync(join(scratch, path), execFileSync('git', ['show', `${b.fixedBy.sha}^:${path}`],
        { cwd: root, maxBuffer: 1024 * 1024 }));
    }
    expect(b.fixPresent(scratch)).toBe(false);
    // Native ESM keeps Vite's module cache and root restrictions out of the parent replay.
    const code = `import b from ${JSON.stringify(pathToFileURL(join(root, 'scripts/conveyor/soak/breaks/refused-stage-pending-referrals-never-resume.mjs')).href)};
      process.stdout.write(JSON.stringify(await b.run({ sourceRoot: process.argv[1] })));`;
    const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, scratch],
      { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }));
    expect(report.violations.filter(message => message.startsWith('scenario failed:'))).toEqual([]);
    expect(report.cases).toHaveLength(7);
    for (const kind of ['all-ruled-auto', 'all-ruled-explicit']) {
      // Automatic pre-fix recovery may complete a fresh panel; completion alone
      // is insufficient. The scenario requires this run and its cached keys to clear.
      expect(report.violations).toContain(`${kind}: later rulings must rewind and complete the refused run with no cached pending keys`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 90_000);
