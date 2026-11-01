// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {loadTestSelector} from '../forge-test-selection.mjs';
import {buildManifest} from '../remote-exec.mjs';
import {keepAliveScript} from '../../lib/test-keepalive.mjs';

const argv=['npx','vitest','run'];
const cwd=await fs.realpath(process.cwd());
const output=files=>({stdout:JSON.stringify(files)});
const execute=promisify(execFile);
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(config) {
  const root=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-selection-')));roots.push(root);
  await fs.symlink(new URL('../../../node_modules',import.meta.url).pathname,join(root,'node_modules'),'dir');
  await fs.writeFile(join(root,'vitest.config.mjs'),config);
  return root;
}

it('uses the absolute discovery set as cwd-relative byte paths, retaining selected and opaque names',async()=>{
  const selected=await loadTestSelector({cwd,argv,exec:async()=>output([join(cwd,'tests/é.test.ts'),join(cwd,'tests/😀.test.ts')])});
  expect(await selected(Buffer.from('tests/é.test.ts'))).toBe(true);
  expect(await selected('tests/😀.test.ts')).toBe(true);
  expect(await selected(Buffer.from('_site/assets/js/__tests__/x.test.ts'))).toBe(false);
  expect(await selected(Buffer.from([0xff]))).toBe(true);
  expect(await selected(null)).toBe(true);
});

it('selects with a symlinked cwd using real Vitest discovery',async()=>{
  const root=await fixture("export default {test:{include:['selected.test.mjs'],exclude:[]}};");
  await fs.writeFile(join(root,'selected.test.mjs'),"throw new Error('must never execute');");
  const alias=join(root,'lane-alias');await fs.symlink(root,alias,'dir');
  const selected=await loadTestSelector({cwd:alias,argv});
  expect(await selected('selected.test.mjs')).toBe(true);
  expect(await selected('omitted.test.mjs')).toBe(false);
});

it('retains manifest fallback for an ignored dependency executed by real Vitest despite discovery filters',async()=>{
  const root=await fixture("export default {test:{include:['**/*.test.mjs'],exclude:[],poolOptions:{threads:{singleThread:true}}}};");
  await fs.writeFile(join(root,'.gitignore'),'node_modules/\nb.test.mjs\n');
  await fs.writeFile(join(root,'package-lock.json'),'{}');
  await fs.writeFile(join(root,'b.test.mjs'),'export const value = 42;');
  await fs.writeFile(join(root,'a.test.mjs'),"import {it,expect} from 'vitest'; import {value} from './b.test.mjs'; it('imports ignored dependency',()=>expect(value).toBe(42));");
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  const git=async args=>execute('git',args,{cwd:root,env,timeout:10000,maxBuffer:1024*1024});
  await git(['init','-q']);await git(['add','.']);
  await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const command=[...argv,'a.test.mjs'];
  const selected=await loadTestSelector({cwd:root,env,argv:command,timeoutMs:10000});
  expect(await selected('a.test.mjs')).toBe(true);expect(await selected('b.test.mjs')).toBe(false);
  const result=await execute(process.execPath,[new URL('../../../node_modules/vitest/vitest.mjs',import.meta.url).pathname,'run','a.test.mjs'],
    {cwd:root,env,timeout:20000,maxBuffer:1024*1024});
  expect(result.stdout).toContain('1 passed');
  await expect(buildManifest({cwd:root,env,argv:command})).rejects.toMatchObject({code:'ignored-test-file',detail:'b.test.mjs'});
},45000);

it.each(['empty','outside only','mixed outside','cwd itself'])('retains refusal for invalid discovery boundaries: %s',async fault=>{
  const root=await fixture('export default {};');
  const physical=await fs.realpath(root);
  const files=fault==='empty'?[]:fault==='outside only'?[join(physical,'../outside.test.mjs')]
    :fault==='mixed outside'?[join(physical,'selected.test.mjs'),join(physical,'../outside.test.mjs')]:[physical];
  const selected=await loadTestSelector({cwd:root,argv,exec:async()=>output(files)});
  expect(await selected('unlisted.test.mjs')).toBe(true);
});

it('retains refusal without launching discovery when cwd cannot be resolved',async()=>{
  const root=await fixture('export default {};'),exec=vi.fn(async()=>output([]));
  const selected=await loadTestSelector({cwd:join(root,'missing'),argv,exec});
  expect(await selected('unlisted.test.mjs')).toBe(true);
  expect(exec).not.toHaveBeenCalled();
});

it.each([
  ['npx','vitest','run','--config','custom.mjs','--root','other','--dir','tests','--project','one','--project=two','filter'],
  ['vitest','run','-c','custom.mjs','-r','other','--dir=tests','--project=one','--project','two','filter'],
].map(command=>[command]))('maps only known selection flags and positional filters: %j',async command=>{
  const env={DISCOVERY_INPUT:'forwarded'},exec=vi.fn(async()=>output([join(cwd,'selected.test.mjs')]));
  const selected=await loadTestSelector({cwd,argv:command,env,exec});
  expect(await selected('omitted.test.ts')).toBe(false);
  expect(exec).toHaveBeenCalledOnce();
  const [file,args,options]=exec.mock.calls[0];
  expect(file).toBe(process.execPath);expect(args[0]).toMatch(/forge-vitest-select\.mjs$/);
  expect(JSON.parse(args[1])).toEqual({options:{watch:false,run:true,config:'custom.mjs',root:'other',dir:'tests',project:['one','two']},filters:['filter']});
  expect(options).toEqual({cwd,env,encoding:'utf8',timeout:60000,killSignal:'SIGKILL',maxBuffer:4*1024*1024});
});

it('ignores only known reporting flags without consuming filename filters',async()=>{
  const exec=vi.fn(async()=>output([]));
  await loadTestSelector({cwd,argv:[...argv,'--reporter','dot','--reporter=verbose','--silent','--coverage','--coverage=false','target'],exec});
  expect(JSON.parse(exec.mock.calls[0][1][1])).toEqual({options:{watch:false,run:true},filters:['target']});
});

it.each([
  undefined,[],['npm','run','test:unit'],['npx','vitest','related','x'],['vitest','watch'],
  [...argv,'--unknown'],[...argv,'--workspace','projects.mjs'],[...argv,'--coverage.include','x'],
  [...argv,'--config'],[...argv,'--config='],[...argv,'--dir','--silent'],
  [...argv,'--root','a','-r','b'],[...argv,'--silent','false'],[...argv,'--silent=maybe'],
  [...argv,'--coverage','true'],[...argv,'--reporter'],[...argv,'--'],[...argv,'-cother.mjs'],
].map(command=>[command]))('fails closed without launching a child for unsupported argv %#',async command=>{
  const exec=vi.fn(async()=>output([]));
  const selected=await loadTestSelector({cwd,argv:command,exec});
  expect(await selected('_site/x.test.ts')).toBe(true);expect(exec).not.toHaveBeenCalled();
});

it.each(['invalid JSON','object','relative path','non-string path','nul path','lone surrogate','oversized output','child failure','listing failure'])('fails closed for %s',async fault=>{
  const exec=async()=>{
    if(fault.endsWith('failure'))throw new Error(fault);
    return {stdout:{'invalid JSON':'log\n[]','object':'{}','relative path':'["x.test.ts"]','non-string path':'[null]',
      'nul path':JSON.stringify(['/x\0.test.ts']),'lone surrogate':JSON.stringify(['/x'+String.fromCharCode(0xd800)]),
      'oversized output':' '.repeat(4*1024*1024+1)+'[]'}[fault]};
  };
  expect(await (await loadTestSelector({cwd,argv,exec}))('_site/x.test.ts')).toBe(true);
});

it('kills a timed-out real child and retains local fallback',async()=>{
  const root=await fixture(keepAliveScript({maxLifetimeMs:10000,postlude:'await new Promise(()=>{});'}));
  let failure;
  const exec=async(...args)=>{try{return await execute(...args);}catch(error){failure=error;throw error;}};
  const selected=await loadTestSelector({cwd:root,argv,exec,timeoutMs:250});
  expect(await selected('_site/x.test.ts')).toBe(true);
  expect(failure).toMatchObject({killed:true,signal:'SIGKILL'});
});

it('discovers with the lane Vitest, forwarded env, explicit config, includeSource and filters without executing tests',async()=>{
  const root=await fixture("throw new Error('default config must not load');");
  const config=join(root,'chosen.config.mjs');
  await fs.writeFile(config,`
    if(process.env.TEST!=='true'||process.env.VITEST!=='true'||process.env.NODE_ENV!=='custom')throw new Error('wrong CLI env');
    export default {test:{include:[process.env.FORGE_INCLUDE],includeSource:['source.test.mjs'],exclude:[]}};
  `);
  await fs.writeFile(join(root,'selected.test.mjs'),"throw new Error('must never execute');");
  await fs.writeFile(join(root,'source.test.mjs'),"if(import.meta.vitest)throw new Error('must never execute');");
  const options={cwd:root,env:{...process.env,FORGE_INCLUDE:'selected.test.mjs',TEST:'false',VITEST:'false',NODE_ENV:'custom'},argv:[...argv,'-c',config]};
  const selected=await loadTestSelector(options);
  expect(await selected('selected.test.mjs')).toBe(true);expect(await selected('source.test.mjs')).toBe(true);
  expect(await selected('_site/assets/js/__tests__/x.test.ts')).toBe(false);
  const filtered=await loadTestSelector({...options,argv:[...options.argv,'selected']});
  expect(await filtered('source.test.mjs')).toBe(false);expect(await filtered('selected.test.mjs')).toBe(true);
});

it('uses Vitest workspace discovery and project selection',async()=>{
  const root=await fixture('export default {};');
  await fs.writeFile(join(root,'vitest.workspace.mjs'),`export default [
    {test:{name:'one',include:['one.test.mjs']}},
    {test:{name:'two',include:['two.test.mjs']}}
  ];`);
  for(const name of ['one','two'])await fs.writeFile(join(root,name+'.test.mjs'),"throw new Error('must never execute');");
  const selected=await loadTestSelector({cwd:root,argv:[...argv,'--project','two']});
  expect(await selected('one.test.mjs')).toBe(false);expect(await selected('two.test.mjs')).toBe(true);
});

it('fails closed when the actual child cannot load its config',async()=>{
  const root=await fixture("throw new Error('discovery unavailable');");
  expect(await (await loadTestSelector({cwd:root,argv}))('_site/x.test.ts')).toBe(true);
});

it.each(['pairs','strings','throws'])('normalizes %s discovery and closes the lane context, including listing errors',async shape=>{
  const root=await fs.mkdtemp(join(process.env.TMPDIR,'forge-vitest-api-'));roots.push(root);
  const module=join(root,'node_modules/vitest');await fs.mkdir(module,{recursive:true});
  await fs.writeFile(join(module,'package.json'),JSON.stringify({type:'module',exports:{'./node':'./node.mjs'}}));
  await fs.writeFile(join(module,'node.mjs'),`
    import {writeFile} from 'node:fs/promises';
    import {resolve} from 'node:path';
    export async function createVitest(mode,options) {
      if(mode!=='test'||options.watch!==false)throw new Error('wrong discovery mode');
      if(process.env.TEST!=='true'||process.env.VITEST!=='true'||process.env.NODE_ENV!=='test')throw new Error('wrong default CLI env');
      return {
        async globTestFiles(filters) {
          if(${JSON.stringify(shape)}==='throws')throw new Error('listing failed');
          const file=resolve('selected.test.mjs');
          return ${JSON.stringify(shape)}==='pairs'?[[{},file]]:[file];
        },
        async close(){await writeFile('closed.json',JSON.stringify(options));},
        async start(){throw new Error('tests must never start');}
      };
    }
  `);
  const selected=await loadTestSelector({cwd:root,argv,env:{...process.env,TEST:'false',VITEST:'false',NODE_ENV:undefined}});
  expect(await selected('selected.test.mjs')).toBe(true);
  expect(await selected('_site/omitted.test.mjs')).toBe(shape==='throws');
  expect(JSON.parse(await fs.readFile(join(root,'closed.json'),'utf8'))).toMatchObject({watch:false});
});

it('delegates absolute/negated globs and root/dir resolution to the lane Vitest',async()=>{
  const root=await fixture('export default {};');
  await fs.mkdir(join(root,'project/tests'),{recursive:true});
  await fs.writeFile(join(root,'project/tests/keep.test.mjs'),"throw new Error('must never execute');");
  await fs.writeFile(join(root,'project/tests/skip.test.mjs'),"throw new Error('must never execute');");
  await fs.writeFile(join(root,'project/vitest.config.mjs'),`export default {test:{
    include:[${JSON.stringify(join(root,'project/tests/*.test.mjs'))},'!**/skip.test.mjs'],exclude:[]
  }};`);
  const selected=await loadTestSelector({cwd:root,argv:[...argv,'--root','project','--dir','tests']});
  expect(await selected('project/tests/keep.test.mjs')).toBe(true);
  expect(await selected('project/tests/skip.test.mjs')).toBe(false);
});
