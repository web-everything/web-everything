#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseTelemetry, formatTelemetry} from './forge-exec-run.mjs';
export {parseTelemetry, formatTelemetry};

export async function readForgeTelemetry({host='forge',exec=execFile}={}) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))throw new Error('Invalid host');
  const output=await new Promise((resolve,reject)=>exec('ssh',[
    '-o','BatchMode=yes','-o','ConnectTimeout=5',host,
    'sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs telemetry',
  ],{encoding:'utf8',maxBuffer:65536,timeout:8000},(error,stdout)=>error?reject(new Error('forge-unreachable')):resolve(stdout)));
  return parseTelemetry(output);
}
export async function main(args,{read=readForgeTelemetry,write=text=>process.stdout.write(text)}={}) {
  let host='forge',json=false;
  const seen=new Set();
  for(const arg of args){
    const key=arg.startsWith('--host=')?'host':arg;
    if(seen.has(key))throw new Error('Duplicate option');seen.add(key);
    if(arg==='--json')json=true;
    else if(arg.startsWith('--host='))host=arg.slice(7);
    else throw new Error('Usage: forge-telemetry.mjs [--json] [--host=forge]');
  }
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))throw new Error('Invalid host');
  const value=parseTelemetry(JSON.stringify(await read({host})));
  write((json?JSON.stringify(value):formatTelemetry(value,host))+'\n');
}
const cliPath = (()=>{try{return realpathSync(process.argv[1]);}catch{return '';}})();
if(process.argv[1] && cliPath===realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(()=>{
    process.stderr.write('forge-telemetry: unavailable or invalid telemetry\n');process.exitCode=1;
  });
}
