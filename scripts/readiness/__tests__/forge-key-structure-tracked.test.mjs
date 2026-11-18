// @vitest-environment node
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {keyStructureFinding} from '../forge-key-structure.mjs';

// Scoped adaptation of the WIP tracked-file sweep: no whole-repository scan in slice 1.
const fixtures=[
  'scripts/conveyor/__tests__/ci-heal-mark.test.mjs',
  'scripts/conveyor/__tests__/supersede-rule.test.mjs',
  'scripts/operations/__tests__/coroner-transcripts.test.mjs',
  'scripts/readiness/__tests__/remote-git-bundle.test.mjs',
  'scripts/readiness/__tests__/forge-key-structure.test.mjs',
  'scripts/readiness/forge-key-structure.mjs',
];
describe('Forge key structure tracked fixture sources',()=>{
  it.each(fixtures)('adds no finding over ordinary tracked fixture source %s',file=>{
    expect(keyStructureFinding(readFileSync(file))).toBeNull();
  });
});
