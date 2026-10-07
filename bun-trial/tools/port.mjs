#!/usr/bin/env node
// Mechanical first pass: vitest test file -> native bun:test copy under bun-trial/ (mirrored path).
// Usage: node bun-trial/tools/port.mjs <repo-relative test path>...   (hand-fix whatever it leaves)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const rel of process.argv.slice(2)) {
  const src = join(root, rel);
  const dst = join(root, 'bun-trial', rel);
  const srcDir = dirname(src), dstDir = dirname(dst);
  let t = readFileSync(src, 'utf8');
  const pre = [];
  // 1. strip vitest imports
  t = t.replace(/^import\s*\{[^}]*\}\s*from\s*['"]vitest['"];?\n/gm, '');
  // 1b. factories that take importOriginal: bun passes no argument, so snapshot the real module first
  {
    const re = /vi\.mock\((['"])([^'"]+)\1,\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/;
    let n = 0, m;
    while ((m = re.exec(t))) {
      const v = `__actual${n++}`;
      const start = m.index, bodyStart = start + m[0].length;
      const next = t.indexOf('vi.mock(', bodyStart);
      const end = next === -1 ? t.length : next;
      let body = t.slice(bodyStart, end).replace(new RegExp(`\\(?await\\s+${m[3]}\\(\\)\\)?|\\b${m[3]}\\(\\)`, 'g'), v);
      const pre = `const ${v} = { ...(await import(${m[1]}${m[2]}${m[1]})) };\n`;
      t = t.slice(0, start) + pre + `vi.mock(${m[1]}${m[2]}${m[1]}, () =>` + body + t.slice(end);
    }
  }
  t = t.replace(/\bvi\.hoisted\(/g, '((fn) => fn())(');  // no hoisting in bun: run the factory in place
  // 2. vi.* -> native
  t = t.replace(/\bvi\.fn\(/g, 'mock(')
       .replace(/\bvi\.spyOn\(/g, 'spyOn(')
       .replace(/\bvi\.mock\(/g, 'mock.module(')
       .replace(/\bvi\.restoreAllMocks\(\)/g, 'mock.restore()')
       .replace(/\bvi\.clearAllMocks\(\)/g, 'mock.clearAllMocks()')
       .replace(/\bvi\.mocked\(([^()]+)\)/g, '($1)')
       .replace(/\bvi\.stubEnv\(/g, 'stubEnv(')
       .replace(/\bvi\.unstubAllEnvs\(\)/g, 'unstubAllEnvs()')
       .replace(/\bvi\.useFakeTimers\(/g, 'jest.useFakeTimers(')
       .replace(/\bvi\.useRealTimers\(/g, 'jest.useRealTimers(')
       .replace(/\bvi\.(advanceTimersByTime|runAllTimers|getTimerCount|setSystemTime)\(/g, 'jest.$1(');
  // 3. relative specifiers: re-point so they resolve to the same ORIGINAL target from the mirrored dir
  t = t.replace(/((?:\bfrom|\bimport\s*\(?|\bmock\.module\(|\bvi\.mock\()\s*)(['"`])(\.{1,2}\/[^'"`\n]*|\.\.)\2/g, (m0, pre0, q, spec) => {
    const m = m0;
    const abs = resolve(srcDir, spec);
    if (!existsSync(abs) && !existsSync(abs + '.mjs') && !existsSync(abs + '.ts')) return m;
    let r = relative(dstDir, abs);
    if (spec.endsWith('/') && !r.endsWith('/')) r += '/';
    if (!r.startsWith('.')) r = './' + r;
    return pre0 + q + r + q;
  });
  // 3b. file-location constants must keep pointing at the ORIGINAL file so computed repo-root paths still resolve
  const origRel = relative(dstDir, src);
  const usesMeta = /import\.meta\.(url|dirname|dir|filename|path)\b/.test(t);
  t = t.replace(/import\.meta\.url\b/g, '__ORIG_URL')
       .replace(/import\.meta\.(dirname|dir)\b/g, '__ORIG_DIR')
       .replace(/import\.meta\.(filename|path)\b/g, '__ORIG_FILE');
  const metaDecl = usesMeta ? `const __ORIG_URL = new URL('${origRel}', import.meta.url).href;\nconst __ORIG_FILE = new URL(__ORIG_URL).pathname;\nconst __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\\/$/, '');\n` : '';
  // 4. header import
  const used = (n) => new RegExp(`\\b${n}\\b`).test(t);
  const names = ['describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll'].filter(used);
  if (/\bmock\b/.test(t)) names.push('mock');
  if (/\bspyOn\(/.test(t)) names.push('spyOn');
  if (/\bjest\./.test(t)) names.push('jest');
  const helpers = ['stubEnv', 'unstubAllEnvs'].filter((n) => new RegExp(`\\b${n}\\(`).test(t));
  const helperRel = relative(dstDir, join(root, 'bun-trial/env-stub.ts'));
  const hdr = `import { ${[...new Set(names)].join(', ')} } from 'bun:test';\n` +
    (helpers.length ? `import { ${helpers.join(', ')} } from '${helperRel.startsWith('.') ? helperRel : './' + helperRel}';\n` : '') + metaDecl;
  // keep shebang/leading comments first? place import after leading comment block
  const m = t.match(/^((?:\s*\/\/[^\n]*\n|\s*\n|\/\*[\s\S]*?\*\/\n)*)/);
  t = m[1] + hdr + t.slice(m[1].length);
  mkdirSync(dstDir, { recursive: true });
  writeFileSync(dst, t);
  console.log('ported', rel);
}
