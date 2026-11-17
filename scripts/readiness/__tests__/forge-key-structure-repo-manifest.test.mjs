// @vitest-environment node
// Split from forge-key-structure.test.mjs: this one test builds the manifest for the whole tracked repository
// (~80s locally, several minutes under CI coverage), so it gets its own file for CI shard balancing.
import {execFileSync} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildManifest,defaultExec} from '../remote-exec.mjs';
import {keyBearingFixtureNames} from './forge-key-structure-fixtures.mjs';

describe('operator send-back IC_kwDORBt1-c8AAAABnW58dw: tracked fixture exclusion (whole repository)',()=>{
  // test-timings.json records 330s for this full-tree scan. Keep a finite
  // deadline with CI headroom; the scanner's per-blob performance bound is separate.
  it('builds the real repository manifest with tracked fixtures excluded',async()=>{
    const cwd=realpathSync(new URL('../../..',import.meta.url));
    const files=execFileSync('git',['ls-files','-z'],{cwd,maxBuffer:1<<26}).toString().split('\0').filter(Boolean);
    const deleted=new Set(execFileSync('git',['ls-files','--deleted','-z'],{cwd,maxBuffer:1<<26}).toString().split('\0').filter(Boolean));
    // The public baseline is this checkout's HEAD, not a mutable remote ref.
    // All inventories, objects, links and worktree bytes still come from the real repo.
    const exec=call=>defaultExec({...call,args:call.args.map(arg=>arg==='origin/main'?'HEAD':arg)});
    const manifest=await buildManifest({cwd,exec,listFiles:async()=>files.filter(file=>!deleted.has(file))});
    const excluded=new Set(manifest.excluded.map(path=>path.toString()));
    const shipped=new Set(manifest.entries.map(entry=>entry.path.toString()));
    for(const file of keyBearingFixtureNames) {
      expect(excluded.has(file),file).toBe(true);
      expect(shipped.has(file),file).toBe(false);
    }
    for(const file of files) {
      if(deleted.has(file)) {
        expect(shipped.has(file)||excluded.has(file),file).toBe(false);
        continue;
      }
      // Tracked directory links are projected into regular manifest leaves.
      if(lstatSync(join(cwd,file)).isSymbolicLink()) {
        expect([...shipped].some(path=>path.startsWith(file+'/')),file).toBe(true);
      } else expect(Number(shipped.has(file))+Number(excluded.has(file)),file).toBe(1);
    }
  },600000);
});
