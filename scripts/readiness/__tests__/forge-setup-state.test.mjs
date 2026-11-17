// @vitest-environment node
import {it, expect} from 'vitest';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseTelemetry} from '../forge-exec-run.mjs';

it('setup writer records installed bytes atomically, reruns safely, and warns with null SHA outside Git',()=>{
  const source = readFileSync(new URL('../forge-setup.sh',import.meta.url),'utf8');
  const allowed = JSON.parse('['+source.match(/allowed = \{([^\n]+)\}/)[1]+']');
  const installed = JSON.parse(source.match(/installed = (\[[^\n]+\])/)[1]);
  // Exercise the actual writer in isolation; host provisioning requires root.
  const start = source.indexOf('        # S0:');
  const end = source.indexOf('\n    finally:\n        os.close(dest)',start);
  const writer = source.slice(start,end).split('\n').map(line=>line.slice(8)).join('\n');
  expect(writer).toContain('os.rename(pending, "state.json"');
  const root = mkdtempSync(join(tmpdir(),'forge-state-'));
  try {
    const lib = join(root,'lib'), bundles = join(root,'bundles');
    mkdirSync(lib); mkdirSync(bundles);
    for (const name of installed) writeFileSync(join(bundles,name),'installed '+name);
    const digest = createHash('sha256');
    for (const name of [...installed].sort()) digest.update(name+'\0'+createHash('sha256').update('installed '+name).digest('hex')+'\n');
    const expectedDigest = digest.digest('hex');
    const sourceDir = fileURLToPath(new URL('../',import.meta.url));
    const checkout = resolve(sourceDir,'../..');
    const expectedSha = execFileSync('git',['log','-1','--format=%H','HEAD','--',...allowed.sort().map(name=>'scripts/readiness/'+name)],{cwd:checkout,encoding:'utf8'}).trim();
    const run = dir => spawnSync('python3',['-c',[
      'import os, sys, secrets, re, json',
      // Check ownership requests without requiring a root test process.
      'def check_owner(fd, uid, gid):\n    assert (uid, gid) == (0, 0)',
      'os.fchown = check_owner',
      'flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW',
      'source_dir, dest_path = sys.argv[1:]',
      'dest = os.open(dest_path, flags)',
      'allowed = '+JSON.stringify(allowed),
      'installed = '+JSON.stringify(installed),
      writer.replace('os.open("/var/lib", flags)','os.open('+JSON.stringify(lib)+', flags)').replaceAll('st.st_uid != 0','st.st_uid != os.getuid()'),
      'os.close(dest)',
    ].join('\n'),dir,bundles],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    for (const dir of [sourceDir,sourceDir,join(root,'not-git','scripts','readiness')]) {
      const output = run(dir);
      expect(output.status,output.stderr).toBe(0);
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe(dir===sourceDir?'':'forge-setup: installed set git SHA unavailable; recording null\n');
      const state = JSON.parse(readFileSync(join(lib,'forge-deploy','state.json'),'utf8'));
      expect(state).toMatchObject({schema:1,forgeSetSha:dir===sourceDir?expectedSha:null,setDigest:expectedDigest,hostTier:1});
      expect(statSync(join(lib,'forge-deploy')).mode & 0o777).toBe(0o755);
      expect(statSync(join(lib,'forge-deploy','state.json')).mode & 0o777).toBe(0o644);
      expect(readdirSync(join(lib,'forge-deploy'))).toEqual(['state.json']);
      // The setup timestamp must pass the same strict ET validator as telemetry.
      expect(parseTelemetry(JSON.stringify({sampledAtET:state.installedAtET,cores:1,loadPerCore:0,memFreePct:50,activeRuns:0,recent:[]}))).toBeTruthy();
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
