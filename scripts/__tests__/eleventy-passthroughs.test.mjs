// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const TemplateConfig = require('@11ty/eleventy/src/TemplateConfig');
const TemplatePassthroughManager = require('@11ty/eleventy/src/TemplatePassthroughManager');
const { registerPassthroughs } = require('../../eleventy/passthroughs.cjs');

test('assets passthrough copies production assets but excludes test directories and test/spec files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eleventy-passthroughs-'));
  try {
    const input = join(root, 'src');
    const output = join(root, 'output');
    const assets = {
      'js/ok.js': 'export const ok = true;',
      'logo.svg': '<svg/>',
      'nested/test.js': '// ordinary asset',
      'js/__tests__/x.test.ts': '// test',
      'js/__tests__/helper.js': '// test helper',
      '__tests__/root.txt': 'test data',
      'nested/deeper/__tests__/fixture.json': '{}',
      'root.test.js': '// test',
      'root.spec.ts': '// spec',
      'js/unit.test.ts': '// test',
      'nested/deeper/component.spec.jsx': '// spec',
      'nested/data.test.json': '{}',
    };
    for (const [path, content] of Object.entries(assets)) {
      const destination = join(input, 'assets', path);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, content);
    }
    await mkdir(join(input, 'assets/empty/__tests__'), { recursive: true });

    // Use the real registration and Eleventy copy engine without loading the site config.
    const config = new TemplateConfig(undefined, false);
    registerPassthroughs(config.userConfig);
    const manager = new TemplatePassthroughManager(config);
    manager.setInputDir(input);
    manager.setOutputDir(output);
    manager.setRunMode('build');
    const registration = manager.getConfigPaths().find(({ inputPath }) => inputPath === './src/assets');
    expect(registration).toBeDefined();
    const passthrough = manager.getTemplatePassthroughForPath({
      ...registration,
      inputPath: join(input, 'assets'),
    });
    await manager.copyPassthrough(passthrough);

    for (const path of ['js/ok.js', 'logo.svg', 'nested/test.js']) {
      expect(await readFile(join(output, 'assets', path), 'utf8')).toBe(assets[path]);
    }
    const entries = await readdir(output, { recursive: true });
    expect(entries.filter(path => path.split(/[\\/]/).includes('__tests__'))).toEqual([]);
    expect(entries.filter(path => /\.(test|spec)\.[^/\\]*$/.test(path))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
