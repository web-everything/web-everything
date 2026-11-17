// @vitest-environment node
// Integration tier (vitest.integration.config.ts): reads every tracked file, which costs minutes on a loaded
// host. It is excluded from the coverage-instrumented unit shards, where it exceeded the shard cap.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {credentialBufferFinding} from '../forge-exec-manifest.mjs';

const FINDING='private-key-structure';

describe('forge-key-structure: tracked files',()=>{
  it('adds no structure findings over tracked fixture sources',()=>{
    const files=execFileSync('git',['ls-files','-z'],{maxBuffer:1<<26}).toString().split('\0').filter(Boolean);
    const hits=[];
    for(const file of files) {
      let bytes;
      try {bytes=readFileSync(file);} catch {continue;}
      if(bytes.length>3*1024*1024)continue;
      if(credentialBufferFinding(bytes)===FINDING)hits.push(file);
    }
    // Short fake bodies and unrelated decimal literals are not complete RSA private structures.
    // Keep the inventory clean without path exemptions: real keys remain blocked at these paths.
    expect(hits).toEqual([]);
  },600000);
});
