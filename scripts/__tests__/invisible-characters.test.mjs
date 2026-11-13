import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pinnedFixture } from '../hooks/__tests__/pinned-fixture.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanInvisibleCharacters } from '../check-standards-rules.mjs';
import { scanInvisibleSourceTree } from '../lib/invisible-source-scan.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const settings = JSON.parse(readFileSync(join(sourceRoot, '.claude/settings.json'), 'utf8'));
const hook = settings.hooks.PreToolUse.find((block) => block.matcher === 'Edit|Write')
  .hooks.find((entry) => entry.command.includes('lint-invisible-characters.mjs'));
let fixture, root;
beforeAll(() => { fixture = pinnedFixture(); root = fixture.primary; }, 30_000);
afterAll(() => fixture?.cleanup());
function invoke(tool_name, tool_input) {
  return fixture.command(root, hook.command, { tool_name, tool_input, cwd: root });
}

describe('invisible source characters (#2866)', () => {
  for (const [character, label] of [['\u200b', 'U+200B'], ['\ufeff', 'U+FEFF'], ['\u00a0', 'U+00A0']]) {
    for (const file of ['scripts/nested/example.mjs', 'docs/example.md']) {
      it(`configured Write hook refuses ${label} in ${file}, naming UTF-16 offsets`, () => {
        const result = invoke('Write', { file_path: join(root, file), content: `${character}😀\n${character}` });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(label);
        expect(result.stderr).toContain('offset 0');
        expect(result.stderr).toContain('offset 4');
      });
    }
  }

  it('allows visible escapes and ordinary prose, and normalizes the path before scoping', () => {
    expect(invoke('Write', { file_path: 'docs/../scripts/example', content: '\u200b' }).status).toBe(2);
    for (const file of ['scripts/example.mjs', 'docs/prose.md']) {
      expect(invoke('Write', { file_path: file, content: 'é 😀 ordinary space \\u200b \\ufeff \\u00a0' }).status).toBe(0);
    }
    for (const file of ['reports/example.md', 'scripts/../reports/example.md', '/tmp/scripts/example.mjs']) {
      expect(invoke('Write', { file_path: file, content: '\u200b' }).status).toBe(0);
    }
    expect(invoke('Write', { file_path: 'docs/example.md', content: '\0\u200b' }).status).toBe(2);
  });

  it('checks proposed Edit content, including first/all replacements and literal dollar tokens', () => {
    const dir = mkdtempSync(join(root, 'scripts', '.invisible-test-'));
    const file = join(dir, 'example.mjs');
    try {
      writeFileSync(file, 'first second first');
      const rejected = invoke('Edit', { file_path: file, old_string: 'first', new_string: '\u00a0' });
      expect(rejected.status).toBe(2);
      expect(readFileSync(file, 'utf8')).toBe('first second first');
      writeFileSync(file, '😀\n\u200b and \u200b');
      expect(invoke('Edit', { file_path: file, old_string: '\u200b', new_string: '' }).status).toBe(2);
      expect(invoke('Edit', { file_path: file, old_string: '\u200b', new_string: '', replace_all: true }).status).toBe(0);
      writeFileSync(file, '\ufeff');
      expect(invoke('Edit', { file_path: file, old_string: '\ufeff', new_string: '$&' }).status).toBe(0);
      expect(invoke('Edit', { file_path: file, old_string: 'absent', new_string: '\u200b' }).status).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('backstop catches direct disk writes, preserves leading BOMs, and attributes findings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invisible-source-'));
    try {
      for (const subdir of ['scripts/nested', 'docs', 'reports']) mkdirSync(join(dir, subdir), { recursive: true });
      writeFileSync(join(dir, 'scripts/nested/extensionless'), '\ufeff😀\n\u200b\u00a0');
      writeFileSync(join(dir, 'docs/prose.md'), 'word\u00a0word');
      writeFileSync(join(dir, 'reports/outside.md'), '\u200b');
      writeFileSync(join(dir, 'docs/binary.bin'), Buffer.from([0xff, 0xfe, 0x20]));
      writeFileSync(join(dir, 'docs/nul.bin'), '\0\u200b');
      const findings = scanInvisibleSourceTree(dir);
      expect(findings).toHaveLength(4);
      expect(findings.filter((hit) => hit.descriptor.file.startsWith('scripts/')).map((hit) => hit.descriptor))
        .toEqual([0, 4, 5].map((offset) => ({ kind: 'invisible-character', fix: 'model',
          file: 'scripts/nested/extensionless', offset, line: offset === 0 ? 1 : 2 })));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('has no existing corpus exceptions and the production gate emits the backstop findings as errors', () => {
    expect(scanInvisibleSourceTree(sourceRoot)).toEqual([]);
    const gate = readFileSync(join(sourceRoot, 'scripts/check-standards.mjs'), 'utf8');
    expect(gate).toContain('for (const finding of scanInvisibleSourceTree(ROOT)) err(finding.message, finding.descriptor)');
    expect(scanInvisibleCharacters([{ file: 'docs/example.md', content: '\ufeff' }])[0].message).toContain('U+FEFF');
  });
});
