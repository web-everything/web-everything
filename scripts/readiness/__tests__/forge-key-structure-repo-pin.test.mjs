// @vitest-environment node
// Split from forge-key-structure.test.mjs: this one test scans every tracked file (~70s locally, several
// minutes under CI coverage), so it gets its own file for CI shard balancing.
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {ordinaryPathKeyFinding} from '../forge-exec-manifest.mjs';
import {keyBearingFixtureNames} from './forge-key-structure-fixtures.mjs';

describe('forge-key-structure: tracked files (whole repository)',()=>{
  // test-timings.json records 280s for this full-tree scan. Match the manifest
  // test's CI headroom without changing the scanner's per-blob performance bound.
  it('pins the key-bearing fixtures in the repository tracked files',()=>{
    const files=new Set(execFileSync('git',['ls-files','-z'],{maxBuffer:1<<26}).toString().split('\0').filter(Boolean));
    const deleted=new Set(execFileSync('git',['ls-files','--deleted','-z'],{maxBuffer:1<<26}).toString().split('\0').filter(Boolean));
    const hits=[];
    for(const file of files) {
      if(deleted.has(file))continue;
      if(!lstatSync(file).isFile())continue;
      if(ordinaryPathKeyFinding(readFileSync(file)))hits.push(file);
    }
    expect(hits.sort()).toEqual([...keyBearingFixtureNames].sort());
  },600000);
});
