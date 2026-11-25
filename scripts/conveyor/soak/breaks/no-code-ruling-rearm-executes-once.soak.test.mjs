import b from './no-code-ruling-rearm-executes-once.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

defineBreakTest(b);

it('export probe reports the feature absent when either writer or receipt reader is removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'no-code-rearm-exports-'));
  try {
    mkdirSync(join(root, 'scripts/operations'), { recursive: true });
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    const writer = join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs');
    const reader = join(root, 'scripts/conveyor/stand-down-answer-core.mjs');
    writeFileSync(writer, 'export function defaultRearmNoCode() {}');
    writeFileSync(reader, 'export function isNoCodeRearmExecuted() {}\nexport function noCodeRearmState() {}');
    expect(b.fixPresent(root)).toBe(true);
    writeFileSync(writer, '// rearm-no-code feature removed\n');
    expect(b.fixPresent(root)).toBe(false);
    writeFileSync(writer, 'export function defaultRearmNoCode() {}');
    writeFileSync(reader, '// no-code-rearm reader removed\n');
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
