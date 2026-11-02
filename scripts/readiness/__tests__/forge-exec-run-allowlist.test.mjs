// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {mkdtemp, mkdir, symlink, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {allowedCommand, executionArgv, createRunner} from '../forge-exec-run.mjs';
// R335: soak's --config flag and the always-run guard's json report, nothing wider.
const soak = ['npx','vitest','run','--config','vitest.soak.config.ts','a.test.mjs'];
describe('runner allowlist widening', () => {
  it('admits the soak config flag as two tokens and passes it through', () => {
    expect(allowedCommand(soak)).toBe(true);
    expect(executionArgv(soak)).toEqual(['node','node_modules/vitest/vitest.mjs','run','--config','vitest.soak.config.ts','a.test.mjs']);
  });
  it('refuses every other config form', () => {
    for (const bad of [['--config'],['--config','/etc/x.config.ts'],['--config','../x.config.ts'],['--config','a/../x.config.ts'],
      ['--config','-x.config.ts'],['--config','x.config.json'],['--config','a\\b.config.ts'],['--config','.git/x.ts'],['--config=vitest.soak.config.ts'],
      ['--config','x.config.ts','--config','y.config.ts','--config']])
      expect(allowedCommand(['npx','vitest','run',...bad,'a.test.mjs'])).toBe(false);
    expect(allowedCommand(['npm','run','test:unit','--','--config','vitest.soak.config.ts'])).toBe(false);
  });
  it('admits the json report written to a work-relative file only', () => {
    const ok = ['npx','vitest','run','a.test.mjs','--reporter=default','--reporter=json','--outputFile.json=.guard/report.json'];
    expect(allowedCommand(ok)).toBe(true);
    expect(executionArgv(ok).slice(-3)).toEqual(['--reporter=default','--reporter=json','--outputFile.json=.guard/report.json']);
  });
  it('refuses report paths that could escape the work dir or use other forms', () => {
    for (const bad of ['--outputFile.json=/tmp/r.json','--outputFile.json=../r.json','--outputFile.json=a/../../r.json','--outputFile.json=',
      '--outputFile.json=-r.json','--outputFile.json=.git/r.json','--outputFile.json=a\\r.json','--outputFile=r.json','--outputFile.junit=r.xml','--outputFile.json','--reporter=junit'])
      expect(allowedCommand(['npx','vitest','run','a.test.mjs',bad])).toBe(false);
  });
  it('refuses a report or config path that goes through a link inside the work dir', async () => {
    const root = await realpath(await mkdtemp(join(process.env.TMPDIR, 'forge-contain-')));
    try {
      const work = join(root, 'work');
      await mkdir(join(root, 'outside'), {recursive: true});
      await mkdir(work, {recursive: true});
      await symlink(join(root, 'outside'), join(work, 'guard'));
      const runner = createRunner({testRoot: root, testPath: '/usr/bin:/bin'});
      await expect(runner.assertContained(work, ['npx','vitest','run','a.test.mjs','--outputFile.json=guard/r.json'])).rejects.toThrow('escapes');
      await symlink(join(root, 'outside'), join(work, 'cfg.config.ts'));
      await expect(runner.assertContained(work, ['npx','vitest','run','--config','cfg.config.ts','a.test.mjs'])).rejects.toThrow('escapes');
      await expect(runner.assertContained(work, ['npx','vitest','run','--outputFile.json=new/r.json','a.test.mjs'])).resolves.toBeUndefined();
    } finally { await rm(root, {recursive: true, force: true}); }
  });
  it('refuses a config together with a report path, since a config can move the reporter root', () => {
    expect(allowedCommand(['npx','vitest','run','--config','vitest.soak.config.ts','a.test.mjs','--reporter=json','--outputFile.json=r.json'])).toBe(false);
  });
  it('keeps refusing the json reporter on the npm classes', () => {
    for (const cls of ['test:unit','test:integration:vitest','test:coverage'])
      expect(allowedCommand(['npm','run',cls,'--','a.test.mjs','--reporter=json'])).toBe(false);
  });
  it('refuses the audit-flagged combinations (narrow R335 reading)', () => {
    expect(allowedCommand(['npx','vitest','run','--config','vitest.soak.config.ts','a.test.mjs','--reporter=json'])).toBe(false);
    expect(allowedCommand(['npx','vitest','run','--config','other.config.ts','a.test.mjs'])).toBe(false);
    expect(allowedCommand(['npm','run','test:integration:vitest','--','a.test.mjs','--reporter=json','--outputFile.json=r.json'])).toBe(false);
    expect(allowedCommand(['npm','run','test:unit','--','a.test.mjs','--outputFile.json=r.json'])).toBe(false);
  });
});
