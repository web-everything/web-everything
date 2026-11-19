/** Disguised credentials must never reach the Forge manifest. */
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(fileURLToPath(import.meta.url),'../../../../..');
// Probe the requested tree in Node: fixPresent is synchronous in the soak harness.
// A load failure or unrelated exception cannot count as evidence of the fix.
function rejectsDisguisedKey(root) {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {generateKeyPairSync} from 'node:crypto';
    import {manifestEntry} from './scripts/readiness/forge-exec-manifest.mjs';
    const {privateKey}=generateKeyPairSync('ed25519');
    const content=Buffer.from(JSON.stringify(privateKey.export({format:'jwk'})));
    try {
      manifestEntry(Buffer.from('docs/notes.md'),content,false,true);
      process.exitCode=1;
    } catch(error) {
      process.exitCode=error.code==='excluded-source-file'?0:2;
    }
  `],{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:65536});
  return !result.error&&result.status===0;
}

export default {
  id:'forge-manifest-scan-all',
  title:'Forge refuses a private key disguised as ordinary documentation',
  card:'Forge manifest scan-all security fix',
  fixedBy:{sha:'pending',where:'forge-manifest-scan-all',paths:['scripts/readiness/forge-exec-manifest.mjs']},
  fixPresent:rejectsDisguisedKey,
  async run() {
    return {violations:rejectsDisguisedKey(process.env.SOAK_TREE_ROOT||ROOT)
      ?[]:['disguised credential admitted or scan evidence unavailable']};
  },
  judge(report) {return report.violations;},
};
