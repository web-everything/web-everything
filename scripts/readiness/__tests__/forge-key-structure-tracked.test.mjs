// @vitest-environment node
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {keyStructureFinding} from '../forge-key-structure.mjs';
import {credentialBufferFinding} from '../forge-exec-manifest.mjs';
import {scanBundleRange} from '../remote-git-bundle.mjs';

// Bounded CI sweep includes prose, large structured text and compressed binary blobs.
const ordinaryTextFixtures=[
  'reports/2026-06-18-conformance-validator-home.md',
  'backlog/2112-reserved-delimiter-family-policy-which-opens-are-platform-re.md',
  'docs/agent/platform-decisions.md',
  'custom-elements.json',
  'reports/decision-docket-data.json',
];
const fixtures=[
  'scripts/conveyor/__tests__/ci-heal-mark.test.mjs',
  'scripts/conveyor/__tests__/supersede-rule.test.mjs',
  'scripts/operations/__tests__/coroner-transcripts.test.mjs',
  'scripts/readiness/__tests__/remote-git-bundle.test.mjs',
  'scripts/readiness/__tests__/forge-key-structure.test.mjs',
  'scripts/readiness/forge-key-structure.mjs',
  'scripts/lib/__tests__/gh-app-shim.test.mjs',
  ...ordinaryTextFixtures,
  'design-refs/items/253b45a916c9cfe2/screenshot.webp',
];
describe('Forge key structure tracked fixture sources',()=>{
  it('admits ordinary binary and JSON fixtures at the documented 1 MiB ceiling',()=>{
    const ceiling=1024*1024;
    const binary=createHash('shake256',{outputLength:ceiling}).update('forge admission ceiling fixture').digest();
    const row=JSON.stringify({title:'ordinary documentation',count:123});
    const rows='['+Array.from({length:Math.floor((ceiling-2)/(row.length+1))},()=>row).join(',')+']';
    const json=Buffer.from(rows.padEnd(ceiling,' '));
    for(const content of [binary,json]) {
      expect(content.length).toBe(ceiling);
      expect(keyStructureFinding(content)).toBeNull();
      expect(credentialBufferFinding(content)).toBeNull();
    }
  });
  it.each(fixtures)('adds no finding over ordinary tracked fixture source %s',file=>{
    const content=readFileSync(file);
    expect(keyStructureFinding(content)).toBeNull();
    // The bundle scanner uses this shared admission hook for every added blob.
    expect(credentialBufferFinding(content)).not.toBe('private-key-scan-budget-exhausted-use-local');
  });
  it.each(ordinaryTextFixtures)(
    'admits the ordinary tracked blob through the bundle scanner: %s',async file=>{
      const content=readFileSync(file),commit='a'.repeat(40),blob='b'.repeat(40);
      const rawCommit=Buffer.from('tree '+'c'.repeat(40)+'\n\npublic update\n');
      // Inject Git object reads; exercise the real scanner without mutating any repository.
      const exec=async ({args,input})=>{
        const argv=args.slice(1);
        let stdout;
        if(argv[0]==='rev-parse')stdout=argv[1]==='--is-shallow-repository'?'false\n':'missing-grafts-fixture\n';
        else if(argv[0]==='rev-list')stdout=commit+'\n';
        else if(argv[0]==='log')stdout=argv.includes('--raw')
          ?`:000000 100644 ${'0'.repeat(40)} ${blob} A\0${file}\0`:'';
        else if(argv[0]==='cat-file') {
          const isCommit=input.trim()===commit;
          const sha=isCommit?commit:blob,type=isCommit?'commit':'blob',body=isCommit?rawCommit:content;
          const header=`${sha} ${type} ${body.length}\n`;
          stdout=argv[1]==='--batch'?Buffer.concat([Buffer.from(header),body,Buffer.from('\n')]):header;
        } else throw new Error('unexpected Git read: '+argv.join(' '));
        return {code:0,stdout:Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout)};
      };
      expect(await scanBundleRange({cwd:process.cwd(),head:commit,prerequisite:null,exec})).toBeNull();
    });
});
