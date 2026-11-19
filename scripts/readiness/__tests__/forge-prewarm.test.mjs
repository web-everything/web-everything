// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {claimPrewarm} from '../forge-exec-bases.mjs';
import {manifestWire,digestManifest,verifyManifest} from '../forge-exec-run.mjs';

let root,paths,source,marker,destination,manifest,manifestDigest,io,verify;
const sha='a'.repeat(40),slot='1',uid=process.getuid();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const claim=()=>claimPrewarm(root,sha,slot,destination,manifest,manifestDigest,verify,io,uid);
beforeEach(async()=>{
  root=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-prewarm-')));
  paths={pool:join(root,'prewarm'),base:join(root,'prewarm',sha),tree:join(root,'prewarm',sha,slot)};
  source=paths.tree;marker=source+'.json';destination=join(root,'runs','run','assembled');
  for(const path of Object.values(paths))await fs.mkdir(path,{mode:0o700});
  await fs.mkdir(join(root,'runs','run'),{recursive:true});
  await fs.writeFile(join(source,'keep.txt'),'trusted leaf',{mode:0o644});
  manifest=manifestWire({entries:[{path:Buffer.from('keep.txt'),sha256:hash('trusted leaf'),executable:false,tracked:true}],excluded:[]});
  manifestDigest=digestManifest(manifest);
  await fs.writeFile(marker,JSON.stringify({sha,manifestDigest}),{mode:0o600});
  io={...fs,rename:vi.fn(fs.rename),chmod:vi.fn(fs.chmod),rm:vi.fn(fs.rm)};
  verify=vi.fn(verifyManifest);
});
afterEach(async()=>fs.rm(root,{recursive:true,force:true}));

// Model a different UID without requiring root, keeping all traversal and IO real.
function otherOwner(path) {
  io.lstat=async target=>{
    const st=await fs.lstat(target);
    return target===path?Object.assign(Object.create(st),{uid:uid+1}):st;
  };
}
async function expectUnclaimed() {
  expect(await claim()).toBe(false);
  expect(verify).not.toHaveBeenCalled();
  expect(io.rename).not.toHaveBeenCalled();
  expect(io.chmod).not.toHaveBeenCalled();
  expect(io.rm).not.toHaveBeenCalled();
  expect(await fs.readFile(join(source,'keep.txt'),'utf8')).toBe('trusted leaf');
  await expect(fs.lstat(destination)).rejects.toMatchObject({code:'ENOENT'});
}

describe('prewarm claim trust boundary',()=>{
  it.each(['pool','base','tree'])('refuses an unsafe owner on the %s directory before claiming',async name=>{
    otherOwner(paths[name]);
    await expectUnclaimed();
  });
  it.each(['pool','base','tree'].flatMap(name=>[0o720,0o702].map(mode=>[name,mode])))
  ('refuses writable %s directory permissions %s before claiming',async(name,mode)=>{
    await fs.chmod(paths[name],mode);
    await expectUnclaimed();
  });
  it.each(['pool','base','tree'])('refuses a symlinked %s directory without touching its target',async name=>{
    await fs.rename(paths[name],paths[name]+'.saved');
    await fs.symlink(paths[name]+'.saved',paths[name]);
    await expectUnclaimed();
  });
  it.each([0o750,0o705])('requires the tree to remain private even with read-only access %s',async mode=>{
    await fs.chmod(source,mode);
    await expectUnclaimed();
  });
  it.each(['other owner','group writable','world writable','symlink','hardlink','directory','missing'])
  ('refuses an unsafe marker (%s) before moving the tree',async fault=>{
    if(fault==='other owner')otherOwner(marker);
    if(fault==='group writable')await fs.chmod(marker,0o620);
    if(fault==='world writable')await fs.chmod(marker,0o602);
    if(fault==='symlink'||fault==='directory') {
      await fs.rename(marker,marker+'.saved');
      if(fault==='symlink')await fs.symlink(marker+'.saved',marker);
      else await fs.mkdir(marker);
    }
    if(fault==='hardlink')await fs.link(marker,marker+'.link');
    if(fault==='missing')await fs.rm(marker);
    await expectUnclaimed();
  });
  it.each(['malformed JSON','missing fields','wrong SHA','wrong digest','extra fields'])
  ('refuses invalid or mismatched marker bytes (%s) without consuming evidence',async fault=>{
    const bytes=fault==='malformed JSON'?'not JSON':fault==='missing fields'?'{}':JSON.stringify({
      sha:fault==='wrong SHA'?'b'.repeat(40):sha,
      manifestDigest:fault==='wrong digest'?'c'.repeat(64):manifestDigest,
      ...(fault==='extra fields'?{extra:true}:{}),
    });
    await fs.writeFile(marker,bytes);
    await expectUnclaimed();
    expect(await fs.readFile(marker,'utf8')).toBe(bytes);
  });
  it('falls back on unreadable marker evidence without claiming the tree',async()=>{
    io.open=async(path,...args)=>{
      if(path===marker)throw Object.assign(new Error('unreadable marker'),{code:'EACCES'});
      return fs.open(path,...args);
    };
    await expectUnclaimed();
  });
  it('preserves an existing destination instead of replacing it',async()=>{
    await fs.mkdir(destination);await fs.writeFile(join(destination,'sentinel'),'keep');
    expect(await claim()).toBe(false);
    expect(verify).not.toHaveBeenCalled();expect(io.rename).not.toHaveBeenCalled();
    expect(await fs.readFile(join(destination,'sentinel'),'utf8')).toBe('keep');
    expect(await fs.readFile(join(source,'keep.txt'),'utf8')).toBe('trusted leaf');
  });
  it('verifies the private claimed tree before exposing it and consumes it exactly once',async()=>{
    const inode=(await fs.stat(join(source,'keep.txt'))).ino;
    verify.mockImplementation(async(...args)=>{
      expect(args).toEqual([destination,manifest,manifestDigest,{fs:io}]);
      expect((await fs.stat(destination)).mode&0o777).toBe(0o700);
      expect(io.chmod).not.toHaveBeenCalled();
      await verifyManifest(...args);
    });
    expect(await claim()).toBe(true);
    expect(verify).toHaveBeenCalledOnce();
    expect(io.rename).toHaveBeenCalledOnce();expect(io.rename).toHaveBeenCalledWith(source,destination);
    expect((await fs.stat(join(destination,'keep.txt'))).ino).toBe(inode);
    expect((await fs.stat(destination)).mode&0o777).toBe(0o755);
    await expect(fs.lstat(source)).rejects.toMatchObject({code:'ENOENT'});
    await expect(fs.lstat(marker)).rejects.toMatchObject({code:'ENOENT'});
    expect(await claim()).toBe(false);expect(verify).toHaveBeenCalledOnce();
  });
  it.each(['tampered bytes','symlink leaf','verifier refusal'])
  ('removes the claimed destination on verification failure (%s), permitting ordinary-copy fallback',async fault=>{
    const victim=join(root,'victim');await fs.writeFile(victim,'outside sentinel');
    if(fault==='tampered bytes')await fs.writeFile(join(source,'keep.txt'),'corrupt');
    if(fault==='symlink leaf') {
      await fs.rm(join(source,'keep.txt'));await fs.symlink(victim,join(source,'keep.txt'));
    }
    verify.mockImplementation(async(...args)=>{
      expect((await fs.stat(destination)).mode&0o777).toBe(0o700);
      if(fault==='verifier refusal')throw new Error('unreadable verification evidence');
      await verifyManifest(...args);
    });
    expect(await claim()).toBe(false);
    expect(verify).toHaveBeenCalledOnce();
    expect(io.rename).toHaveBeenCalledOnce();expect(io.rename).toHaveBeenCalledWith(source,destination);
    expect(io.chmod).not.toHaveBeenCalled();
    expect(io.rm).toHaveBeenCalledOnce();expect(io.rm).toHaveBeenCalledWith(destination,{recursive:true,force:true});
    await expect(fs.lstat(source)).rejects.toMatchObject({code:'ENOENT'});
    await expect(fs.lstat(destination)).rejects.toMatchObject({code:'ENOENT'});
    expect(await fs.readFile(marker,'utf8')).toBe(JSON.stringify({sha,manifestDigest}));
    expect(await fs.readFile(victim,'utf8')).toBe('outside sentinel');
    // A corrupt tree has been consumed, so repeated claims still fall back safely.
    expect(await claim()).toBe(false);expect(verify).toHaveBeenCalledOnce();
    await fs.mkdir(destination);await fs.writeFile(join(destination,'keep.txt'),'trusted leaf');
    await verifyManifest(destination,manifest,manifestDigest);
  });
});
