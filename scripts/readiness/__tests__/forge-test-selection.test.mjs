// @vitest-environment node
import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createTestSelector} from '../forge-test-selection.mjs';

const configs=[
  {include:['scripts/**/__tests__/**/*.test.{mjs,ts}', 'skills-src/**/*.test.mjs'], exclude:['**/integration.test.mjs']},
  {include:['scripts/**/integration.test.mjs'], exclude:[]},
];
it.each([
  ['scripts/build/__tests__/x.test.mjs',true],
  ['skills-src/example/hidden.test.mjs',true],
  ['scripts/__tests__/integration.test.mjs',true],
  ['scripts/__tests__/.hidden/x.test.ts',true],
  ['_site/assets/js/__tests__/x.test.ts',false],
  ['scripts/build/lost.test.mjs',false],
])('selects %s across every config: %s',(path,expected)=>{
  expect(createTestSelector(configs)(Buffer.from(path))).toBe(expected);
});
it('subtracts excludes separately for each config',()=>{
  expect(createTestSelector([configs[0]])('scripts/__tests__/integration.test.mjs')).toBe(false);
});
it.each([
  resolve('scripts/**/*.test.mjs'),
  resolve('scripts'),
  'C:/repo/scripts/**/*.test.mjs',
  '\\\\server\\repo\\scripts\\**\\*.test.mjs',
])('fails closed for absolute include %s selecting an ignored test',pattern=>{
  const ignored='scripts/build/lost.test.mjs';
  expect(createTestSelector([{include:[pattern],exclude:[]}])(Buffer.from(ignored))).toBe(true);
});
it.each(['include','exclude'])('fails closed for negated %s patterns',field=>{
  const config={include:['**/*.test.mjs'],exclude:[],[field]:['!other/**']};
  expect(createTestSelector([config])('scripts/build/lost.test.mjs')).toBe(true);
  expect(createTestSelector([config])('other/lost.test.mjs')).toBe(true);
});
it.each(['include','exclude'])('fails closed for unsupported %s syntax',field=>{
  for(const pattern of [
    '../scripts/**/*.test.mjs', 'scripts/../**/*.test.mjs', './scripts/**/*.test.mjs',
    'scripts/**/+(lost|hidden).test.mjs', 'scripts/**/!(other).test.mjs',
    'scripts/**/x.test.{mjs,{ts,tsx}}', 'scripts/**/x{1..3}.test.mjs',
    'scripts/**/x{,hidden}.test.mjs', 'scripts/**/[a-z].test.mjs',
    'scripts\\**\\*.test.mjs',
  ]) {
    const config={include:['**/*.test.mjs'],exclude:[],[field]:[pattern]};
    // Another config proving non-selection cannot override unknown discovery.
    expect(createTestSelector([configs[0],config])('_site/ignored.test.mjs'),pattern).toBe(true);
  }
});
it('fails closed for an absolute exclude even when the include does not match',()=>{
  expect(createTestSelector([{include:['other/**'],exclude:[resolve('scripts')]}])('scripts/build/lost.test.mjs')).toBe(true);
});
it.each([undefined,[],[{}],[{include:['**/*.test.ts']}],
  [{include:['[bad'],exclude:[]}],[{include:[],exclude:['[bad']}],
  [{include:[null],exclude:[]}], [...configs,{include:[],exclude:null}],
  [{include:['x'.repeat(65537)],exclude:[]}],
])('fails closed for incomplete configs or malformed globs %#',configs=>{
  expect(createTestSelector(configs)('_site/assets/js/__tests__/x.test.ts')).toBe(true);
});
it('fails closed for undecodable paths',()=>{
  expect(createTestSelector(configs)(Buffer.from([0xff]))).toBe(true);
});

it('loads the repository configs in native Node, omitting _site and retaining integration-only tests',()=>{
  const cwd=fileURLToPath(new URL('../../../',import.meta.url));
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {loadTestSelector} from './scripts/readiness/forge-test-selection.mjs';
    const selected=await loadTestSelector({cwd:process.cwd()});
    console.log(JSON.stringify([
      selected('_site/assets/js/__tests__/x.test.ts'),
      selected('scripts/lib/__tests__/atomic-json-file.test.mjs'),
      selected('scripts/__tests__/stdout-flush.test.mjs'),
    ]));
  `],{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
  expect(result.error).toBeUndefined();
  expect(result.status,result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([false,true,true]);
});
