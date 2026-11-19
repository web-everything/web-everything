/** Disguised credentials must never reach the Forge manifest. */
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(fileURLToPath(import.meta.url),'../../../../..');
// Probe the requested tree in Node: fixPresent is synchronous in the soak harness. A load failure or
// unrelated exception cannot count as evidence. The two probes are deliberately different behaviours
// of the same fix: `fixPresent` asks whether the tree has the fail-closed size cap (introduced by the
// fix, independent of the credential scan), `run` asks whether a disguised key is refused. A tree that
// has the cap but admits the key therefore fails the break instead of being marked as unfixed.
const PROBES={
  sizeCap:`
    const content=Buffer.alloc(9*1024*1024,32);
    manifestEntry(Buffer.from('docs/notes.unknownext'),content,false,true);
  `,
  disguisedKey:`
    const {privateKey}=generateKeyPairSync('ed25519');
    const content=Buffer.from(JSON.stringify(privateKey.export({format:'jwk'})));
    manifestEntry(Buffer.from('docs/notes.md'),content,false,true);
  `,
};
function refuses(root,probe) {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {generateKeyPairSync} from 'node:crypto';
    import {manifestEntry} from './scripts/readiness/forge-exec-manifest.mjs';
    try {
      ${PROBES[probe]}
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
  fixPresent:root=>refuses(root,'sizeCap'),
  async run() {
    return {violations:refuses(process.env.SOAK_TREE_ROOT||ROOT,'disguisedKey')
      ?[]:['disguised credential admitted or scan evidence unavailable']};
  },
  judge(report) {return report.violations;},
};
