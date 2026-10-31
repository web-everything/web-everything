// @vitest-environment node
import { EventEmitter } from 'node:events';
import {PassThrough} from 'node:stream';
import * as remote from '../remote-exec.mjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultExec } from '../remote-exec.mjs';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

beforeEach(() => spawn.mockReset());

function capturedChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  spawn.mockReturnValue(child);
  return child;
}

describe('remote-exec captured output boundary', () => {
  // Revised capture contract: defaultExec resolves {code, stdout: Buffer}.
  // Existing content and limit assertions now expect bytes: this is the
  // intentional stdout contract change, with the same capture bounds retained.
  it('returns raw bytes when an é.test.mjs inventory name is split in two chunks', async () => {
    const child = capturedChild();
    const result = defaultExec({file:'git', args:['ls-files','-co','--exclude-standard','-z']});
    const bytes = Buffer.from('é.test.mjs\0');
    child.stdout.emit('data', bytes.subarray(0, 1));
    child.stdout.emit('data', bytes.subarray(1));
    child.emit('close', 0);
    const captured = await result;
    expect(Buffer.isBuffer(captured.stdout)).toBe(true);
    expect(captured.stdout).toEqual(bytes);
  });

  it('never replaces a non-UTF-8 inventory byte with U+FFFD', async () => {
    const child = capturedChild();
    const result = defaultExec({file:'git', args:['ls-files','-z']});
    const bytes = Buffer.concat([Buffer.from('raw-'), Buffer.from([0xff]), Buffer.from('.test.mjs\0')]);
    child.stdout.emit('data', bytes);
    child.emit('close', 0);
    expect((await result).stdout).toEqual(bytes);
  });

  it('preserves multibyte inventory names split across stdout chunks', async () => {
    const child = capturedChild();
    const result = defaultExec({file:'git',args:['ls-files','-z']});
    const inventory = 'fixtures/é😀\u2028.txt\0';
    for (const byte of Buffer.from(inventory)) child.stdout.emit('data',Buffer.from([byte]));
    child.emit('close',0);
    await expect(result).resolves.toEqual({code:0,stdout:Buffer.from(inventory)});
  });
  it('accepts exactly 4 MiB combined across stdout and stderr without terminating', async () => {
    const child = capturedChild();
    const result = defaultExec({ file: 'ssh', args: ['forge', 'true'] });
    child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024, 'a'));
    child.stderr.emit('data', Buffer.alloc(2 * 1024 * 1024, 'b'));
    child.emit('close', 0);

    await expect(result).resolves.toEqual({ code: 0, stdout: Buffer.alloc(2 * 1024 * 1024, 'a') });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['stdout', 'stderr'])('terminates and rejects when combined output exceeds 4 MiB on %s', async (overflowStream) => {
    const child = capturedChild();
    const result = defaultExec({ file: 'ssh', args: ['forge', 'true'] });
    child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024, 'a'));
    child.stderr.emit('data', Buffer.alloc(2 * 1024 * 1024, 'b'));
    expect(child.kill).not.toHaveBeenCalled();

    // Neither individual stream exceeds the bound; the combined byte count does.
    child[overflowStream].emit('data', Buffer.from('!'));
    // Even a success status must not turn an overflow into accepted evidence.
    child.emit('close', 0);

    await expect(result.then(() => undefined)).rejects.toThrow('Captured output limit exceeded');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});


describe('bounded persistent Git blob reader',()=>{
  function batchChild(reply) {
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    child.kill=vi.fn(()=>{child.stdout.end();queueMicrotask(()=>child.emit('close',1));return true;});
    child.stdin.on('data',request=>reply(child,request.toString().trim()));
    child.stdin.on('finish',()=>{child.stdout.end();queueMicrotask(()=>child.emit('close',0));});
    spawn.mockReturnValue(child);return child;
  }
  it('reads multiple exact binary blobs through one process, with chunked protocol framing',async()=>{
    const contents=[Buffer.from('é\0bytes'),Buffer.from([0xff,0,1])];let index=0;
    batchChild((child,oid)=>{const content=contents[index++];const frame=Buffer.concat([Buffer.from(`${oid} blob ${content.length}\n`),content,Buffer.from('\n')]);for(const byte of frame)child.stdout.write(Buffer.from([byte]));});
    const reader=remote.createGitBlobReader({cwd:'local-checkout'});
    expect(await reader.read('a'.repeat(40))).toEqual(contents[0]);
    expect(await reader.read('b'.repeat(40))).toEqual(contents[1]);
    await reader.close();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0].slice(0,2)).toEqual(['git',['cat-file','--batch']]);
  });
  it.each(['missing','wrong object','oversized','truncated','bad terminator'])('refuses %s evidence with full shipping as the explicit fallback',async fault=>{
    const child=batchChild((child,oid)=>{
      if(fault==='missing')child.stdout.write(`${oid} missing\n`);
      if(fault==='wrong object')child.stdout.write(`${'b'.repeat(40)} blob 0\n\n`);
      if(fault==='oversized')child.stdout.write(`${oid} blob ${4*1024*1024+1}\n`);
      if(fault==='truncated'){child.stdout.write(`${oid} blob 5\nx`);child.stdout.end();}
      if(fault==='bad terminator')child.stdout.write(`${oid} blob 1\nx!`);
    });
    const reader=remote.createGitBlobReader({cwd:'local-checkout'});
    await expect(reader.read('a'.repeat(40))).rejects.toThrow(/full ship/i);
    await reader.close();expect(child.kill).toHaveBeenCalled();
  });
});
