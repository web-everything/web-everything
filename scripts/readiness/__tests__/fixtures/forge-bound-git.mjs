import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
// Keep fault injection on the Git subcommand while retaining the binding on IO.
export const gitArgs=call=>call.args[0]?.startsWith('--git-dir=')?call.args.slice(4):call.args;
export function bindingEvidence(call) {
  // The client compares its index with the pinned HEAD at every HEAD symlink; stubbed
  // repositories have no staged link change. forge-head-symlink-change.test.mjs covers the refusals.
  if(call.file==='git'&&gitArgs(call)[0]==='diff-index')return {code:0,stdout:Buffer.alloc(0)};
  if(call.file!=='git'||!call.args.includes('--show-toplevel'))return;
  mkdirSync(join(call.cwd,'.git'),{recursive:true});
  return {code:0,stdout:Buffer.from(realpathSync(call.cwd)+'\n'+realpathSync(join(call.cwd,'.git'))+'\n')};
}

// Mutation modules exist only in memory: never weaken or rewrite the checkout.
// Exact, unique matches make a moved guard fail the gate rather than skip a probe.
export async function manifestMutation(find,replacement) {
  const url=new URL('../../remote-exec.mjs',import.meta.url);
  let source=await readFile(url,'utf8');
  if(source.split(find).length!==2)throw new Error('Mutation guard must match exactly once');
  source=source.replace(find,replacement)
    .replace(/(\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])(\.\.?\/[^'"\n]+)\2/g,
      (_match,prefix,quote,path)=>prefix+quote+new URL(path,url).href+quote)
    .replaceAll('import.meta.url',JSON.stringify(url.href));
  return import(/* @vite-ignore */ 'data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
