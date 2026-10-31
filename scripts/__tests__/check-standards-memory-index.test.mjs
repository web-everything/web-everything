// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../check-standards.mjs',import.meta.url),'utf8');
// Execute the actual producer section, including its subprocess call, without
// running every unrelated standards gate. Fail loudly if its boundaries move.
const start=source.indexOf('// ── 9a″. Agent-memory index-tree shape');
const end=source.indexOf('// ── 9b. Module-resolution exports-lock',start);
if(start<0||end<=start)throw new Error('Missing memory-index standards section');
const section=source.slice(start,end);
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

function runMemorySection({stdout='',stderr='',code=0}) {
  const root=mkdtempSync(join(tmpdir(),'standards-memory-'));roots.push(root);
  mkdirSync(join(root,'scripts'));
  // Stub the checker executable, not the warning producer or its spawn result.
  writeFileSync(join(root,'scripts/check-memory.mjs'),
    `process.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exitCode=${code};\n`);
  const warn=vi.fn(),err=vi.fn(),mark=vi.fn();
  runInNewContext(section,{ROOT:root,join,process,require:createRequire(import.meta.url),warn,err,mark},
    {filename:'scripts/check-standards.mjs',timeout:10000});
  expect(mark).toHaveBeenCalledWith('9a″. Agent-memory index-tree shape (#2192)');
  return {warn,err};
}

describe('check-standards memory-index warning producer',()=>{
  it.each([
    ['stdout',{stdout:'Memory directory missing — skipping\n'}],
    ['stderr',{stderr:'Memory directory missing — SKIPPING\n'}],
  ])('warns when a successful check-memory prints skipping on %s',(_stream,output)=>{
    const {warn,err}=runMemorySection(output);
    expect(err).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `memory-index: ${(output.stdout||output.stderr).trim()}`,
      {kind:'memory-index',file:'.claude/agent-memory/MEMORY.md'});
  });
  it('detects skipping on stderr even when stdout also contains output',()=>{
    const {warn,err}=runMemorySection({stdout:'Checking memory\n',stderr:'skipping missing inputs\n'});
    expect(err).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('memory-index: Checking memory\nskipping missing inputs',
      {kind:'memory-index',file:'.claude/agent-memory/MEMORY.md'});
  });
  it.each(['','Memory index valid\n','skippingExtra is a leaf name\n'])
  ('does not warn for a successful checker without the skip marker: %j',stdout=>{
    const {warn,err}=runMemorySection({stdout});
    expect(warn).not.toHaveBeenCalled();expect(err).not.toHaveBeenCalled();
  });
  it('keeps a nonzero memory check with skipping output an error',()=>{
    const {warn,err}=runMemorySection({stderr:'skipping after failure\n',code:1});
    expect(warn).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('memory-index: skipping after failure',
      {kind:'memory-index',file:'.claude/agent-memory/MEMORY.md'});
  });
});
