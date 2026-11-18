// @vitest-environment node
// R830/R823: these tracked sources used to trip the Forge bundle credential scan (28 fallbacks per 30 min). They are
// fixed at the source (no allow-list): code that only talks ABOUT keys, and fixtures that spell a token in one literal.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { credentialBufferFinding, credentialContentFinding } from '../forge-exec-manifest.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const FILES = [
  'scripts/lib/gh-app-shim.mjs',
  'skills-src/conveyor/__tests__/review-daemon.test.mjs',
  'scripts/readiness/__tests__/git-bundle-transport.test.mjs',
];

describe('tracked sources that handle or fake credentials pass the bundle scan with no allow-list', () => {
  for (const file of FILES) {
    it(file, () => {
      const content = readFileSync(root + file);
      expect(credentialBufferFinding(content)).toBeNull();
      expect(credentialContentFinding(Buffer.from(file), content)).toBeNull();
    });
  }
});
