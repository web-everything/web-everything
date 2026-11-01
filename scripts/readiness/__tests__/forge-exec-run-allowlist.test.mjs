// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {allowedCommand, executionArgv} from '../forge-exec-run.mjs';
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
});
