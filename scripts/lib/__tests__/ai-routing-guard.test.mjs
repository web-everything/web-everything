import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_ROUTING_UNMIGRATED_SITES } from '../ai-routing-unmigrated-sites.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pattern = /\b(?:workerTierFor|resolveOperationRoute|resolveCodexTaskRoute|resolveFixExecutorChain|pickChainRung|resolveClaudeHelperRoute|resolveAccount)\s*\(|--model\b/g;
const count = source => (source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').match(pattern) ?? []).length;
const exempt = new Set(['scripts/lib/ai-routing.mjs', 'scripts/lib/ai-routing-unmigrated-sites.mjs']);
it('AI_ROUTING_UNMIGRATED_SITES refuses new direct resolver or literal model flag sites', () => {
  const actual = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['__tests__', 'node_modules', '__fixtures__'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(mjs|cjs|js)$/.test(entry.name)) {
        const name = relative(root, path).split(sep).join('/');
        if (exempt.has(name)) continue;
        const n = count(readFileSync(path, 'utf8'));
        if (n) actual[name] = n;
      }
    }
  }
  walk(join(root, 'scripts'));
  walk(join(root, 'skills-src'));
  expect(actual, 'route new work through routeForRole; remove census entries only when migrating existing callers').toEqual(AI_ROUTING_UNMIGRATED_SITES);
});
it('the census detector sees a new call and literal model argument even within an existing file', () => {
  expect(count("const r = resolveOperationRoute({}); spawn('claude', ['--model', model]);")).toBe(2);
  expect(count('workerTierFor({}); resolveAccount(env, map);')).toBe(2);
  expect(count('/* resolveAccount(env, map) */\n// --model opus')).toBe(0);
});
