import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:os';
import { describe, it, expect } from 'vitest';
import { runUnderAdmission } from '../heavy-admission.mjs';

const killed = signal => () => { throw Object.assign(new Error('killed'), { status: null, signal }); };
const base = () => ({ lockRoot: mkdtempSync(join(tmpdir(), 'ha-sig-')), cap: 1, owner: 'sig-test', command: 'x', log: () => {}, env: {} });

describe('runUnderAdmission: a signal-killed child is an infrastructure exit, never plain 1', () => {
  it('SIGKILL under admission exits 128+9', async () => {
    const r = await runUnderAdmission({ ...base(), exec: killed('SIGKILL') });
    expect(r.exitCode).toBe(128 + constants.signals.SIGKILL);
  });
  it('SIGTERM on the bypass path exits 128+15', async () => {
    const r = await runUnderAdmission({ ...base(), bypass: 'held', exec: killed('SIGTERM') });
    expect(r.exitCode).toBe(128 + constants.signals.SIGTERM);
  });
  it('an ordinary nonzero status and a status-less non-signal error are unchanged', async () => {
    expect((await runUnderAdmission({ ...base(), exec: () => { throw Object.assign(new Error('r'), { status: 3 }); } })).exitCode).toBe(3);
    expect((await runUnderAdmission({ ...base(), exec: () => { throw new Error('spawn'); } })).exitCode).toBe(1);
  });
});
