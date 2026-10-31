import * as filesystem from 'node:fs/promises';
import {join, resolve} from 'node:path';
import micromatch from 'micromatch';

const refuse = () => true;

// Pure discovery predicate: every config contributes include minus exclude.
// Unknown evidence retains the existing ignored/unshipped-test local fallback.
export function createTestSelector(configs) {
  try {
    if (!Array.isArray(configs) || !configs.length) return refuse;
    const compile = patterns => {
      if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string' || !p.length)) throw new Error('Unknown test globs');
      return patterns.map(pattern => micromatch.matcher(pattern, {dot:true, strictBrackets:true}));
    };
    const selectors = configs.map(({include, exclude}) => ({include:compile(include), exclude:compile(exclude)}));
    return path => {
      try {
        const name = Buffer.isBuffer(path) ? new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(path) : path;
        if (typeof name !== 'string') return true;
        return selectors.some(({include, exclude}) => include.some(match => match(name)) && !exclude.some(match => match(name)));
      } catch { return true; }
    };
  } catch { return refuse; }
}

// Evaluate the actual configs (including imported/computed arrays) with Vite's
// own loader. Keep this client-only: the trusted Forge runtime has no npm deps.
export async function loadTestSelector({cwd, fs = filesystem} = {}) {
  try {
    const names = (await fs.readdir(cwd)).filter(name => /^vitest.*\.config\..+$/.test(name)).sort();
    if (!names.length) return refuse;
    const {loadConfigFromFile} = await import('vite');
    const {configDefaults} = await import('vitest/config');
    const configs = [];
    for (const name of names) {
      const file = join(cwd, name);
      // Explicit IO also keeps unreadable-config behavior injectable in fixtures.
      await fs.readFile(file);
      const loaded = await loadConfigFromFile({command:'serve', mode:'test'}, file, cwd, 'silent');
      if (!loaded?.config) return refuse;
      const config = loaded.config, test = config.test ?? {};
      // Discovery outside cwd or through projects/plugins needs more evidence.
      if ([config.root, test.root, test.dir].some(root => root !== undefined && resolve(cwd, root) !== resolve(cwd))
        || test.workspace !== undefined || test.projects !== undefined || config.plugins?.length) return refuse;
      configs.push({include:test.include ?? configDefaults.include, exclude:test.exclude ?? configDefaults.exclude});
    }
    return createTestSelector(configs);
  } catch { return refuse; }
}
