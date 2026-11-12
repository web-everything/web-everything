import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRegistration } from '../../daemon-overlay.mjs';
let scratch;
afterEach(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
describe('overlay remove uses a concrete registration snapshot', () => {
  it('absent pre-read never calls removeOverlay or deletes a later pinned registration', () => {
    let current = [];
    const late = { ref: 'lane/new', pinned: true };
    const remove = vi.fn(() => { current = []; return { removed: true, list: [] }; });
    const result = removeRegistration({ root: 'unused', ref: late.ref, env: {}, deps: {
      readState: () => { const snapshot = []; current = [late]; return { corrupt: false, overlays: snapshot }; }, remove,
    } });
    expect(result).toEqual({ removed: false, list: [] });
    expect(remove).not.toHaveBeenCalled();
    expect(current).toEqual([late]);
  });
  it('registered removal always supplies the exact non-undefined compare guard', () => {
    scratch = fs.mkdtempSync(join(tmpdir(), 'overlay-snapshot-'));
    const entry = { ref: 'lane/old', pinned: false };
    const remove = vi.fn(() => ({ removed: true, list: [] }));
    const env = { WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays') };
    expect(removeRegistration({ root: join(scratch, 'clone'), ref: entry.ref, env, deps: {
      readState: () => ({ corrupt: false, overlays: [entry] }), remove,
    } })).toEqual({ removed: true, list: [] });
    expect(remove).toHaveBeenCalledWith(expect.any(String), entry.ref, expect.objectContaining({ expectedOverlay: entry }));
    expect(remove.mock.calls[0][2].expectedOverlay).toBe(entry);
  });
  it('corrupt pre-read refuses removal instead of treating incomplete evidence as an absent registration', () => {
    const remove = vi.fn();
    expect(() => removeRegistration({ root: 'unused', ref: 'lane/x', deps: {
      readState: () => ({ corrupt: true, overlays: [] }), remove,
    } })).toThrow(/corrupt/);
    expect(remove).not.toHaveBeenCalled();
  });
});
