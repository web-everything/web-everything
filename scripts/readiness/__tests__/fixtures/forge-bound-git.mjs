import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
// Keep fault injection on the Git subcommand while retaining the binding on IO.
export const gitArgs=call=>call.args[0]?.startsWith('--git-dir=')?call.args.slice(4):call.args;
export function bindingEvidence(call) {
  if(call.file!=='git'||!call.args.includes('--show-toplevel'))return;
  mkdirSync(join(call.cwd,'.git'),{recursive:true});
  return {code:0,stdout:Buffer.from(realpathSync(call.cwd)+'\n'+realpathSync(join(call.cwd,'.git'))+'\n')};
}
