import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import b from './daemon-git-developer-dir.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it.each([
  ['unreadable helper', null],
  ['missing export', 'export const unrelated = true;'],
  ['marker-only no-op', 'export function pinDeveloperDir(env) { return env; }'],
  ['overwrites caller intent', `export function pinDeveloperDir(env, { exists }) {
    if (exists('/Library/Developer/CommandLineTools')) env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
  }`],
  ['pins missing CLT', `export function pinDeveloperDir(env) {
    env.DEVELOPER_DIR ||= '/Library/Developer/CommandLineTools';
  }`],
])('fix presence fails closed: %s', (_name, source) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-developer-dir-'));
  try {
    if (source !== null) {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      writeFileSync(join(root, 'scripts/lib/lane-git-hardening.mjs'), source);
    }
    expect(b.fixPresent(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
