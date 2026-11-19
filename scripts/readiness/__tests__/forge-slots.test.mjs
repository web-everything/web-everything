// @vitest-environment node
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir, hostname} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {resolveForgeSlots} from '../forge-slots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..');
const settings = {forgeSlots: {default: 8, hosts: {forge: 14, 'forge-b': 8}}};
const setup = readFileSync(join(source, 'forge-setup.sh'), 'utf8');
const scratch = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, {recursive: true, force: true}); });
function fixture(config = settings) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-slots-')); scratch.push(dir);
  for (const file of ['forge-slots.mjs', 'forge-slots.sh']) cpSync(join(source, file), join(dir, file));
  writeFileSync(join(dir, 'forge-slots.json'), JSON.stringify(config));
  return dir;
}
function run(dir, env = {}, python = false) {
  let path = process.env.PATH;
  if (python) {
    path = join(dir, 'bin'); mkdirSync(path);
    for (const name of ['python3', 'dirname']) {
      const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'find-command', name], {encoding: 'utf8'});
      expect(found.status).toBe(0);
      symlinkSync(found.stdout.trim(), join(path, name));
    }
  }
  return spawnSync('/bin/bash', [join(dir, 'forge-slots.sh')], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: {PATH: path, ...env},
  });
}

describe('Forge slot settings', () => {
  it('resolves env > host > default and accepts both bounds', () => {
    expect(resolveForgeSlots(settings, {env: {FORGE_EXEC_SLOTS: '1'}, host: 'forge'})).toBe(1);
    expect(resolveForgeSlots(settings, {env: {FORGE_EXEC_SLOTS: '128'}, host: 'forge'})).toBe(128);
    expect(resolveForgeSlots(settings, {host: 'forge.example'})).toBe(14);
    expect(resolveForgeSlots(settings, {host: 'unknown'})).toBe(8);
  });
  it('uses FORGE_HOST ahead of the short hostname', () => {
    expect(resolveForgeSlots(settings, {env: {FORGE_HOST: 'forge.example'}, host: 'forge-b'})).toBe(14);
  });
  it.each(['', '0', '129', '-1', '1.5', 'NaN', '08', '8x', ' 8'])('refuses invalid env %j', value => {
    expect(() => resolveForgeSlots(settings, {env: {FORGE_EXEC_SLOTS: value}})).toThrow('FORGE_EXEC_SLOTS must be 1..128');
  });
  it.each([0, 129, 1.5, '8', null, true])('refuses invalid settings %j even on another host', value => {
    expect(() => resolveForgeSlots({forgeSlots: {default: value, hosts: {}}})).toThrow();
    expect(() => resolveForgeSlots({forgeSlots: {default: 8, hosts: {other: value}}}, {host: 'forge'})).toThrow();
  });
  it.each([null, {}, {forgeSlots: {default: 8}}, {forgeSlots: {default: 8, hosts: []}}])('refuses incomplete settings %j', config => {
    expect(() => resolveForgeSlots(config)).toThrow();
  });
  for (const python of [false, true]) {
    const reader = python ? 'Python fallback without Node' : 'Node CLI';
    it(`${reader}: copied flat deployment reads the same JSON and FORGE_HOST`, () => {
      const result = run(fixture(), {FORGE_HOST: 'forge'}, python);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('14\n');
    });
    it(`${reader}: discovers the machine short hostname`, () => {
      const result = run(fixture({forgeSlots: {default: 8, hosts: {[hostname().split('.')[0]]: 11}}}), {}, python);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('11\n');
    });
    it(`${reader}: env wins and rejects oversized env`, () => {
      const result = run(fixture(), {FORGE_HOST: 'forge', FORGE_EXEC_SLOTS: '12'}, python);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('12\n');
      const invalid = run(fixture(), {FORGE_EXEC_SLOTS: '129'}, python);
      expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain('FORGE_EXEC_SLOTS must be 1..128');
    });
    it(`${reader}: refuses missing, malformed, and invalid JSON settings`, () => {
      for (const text of [null, '{', JSON.stringify({forgeSlots: {default: 8, hosts: {other: 129}}})]) {
        const dir = fixture();
        if (text === null) rmSync(join(dir, 'forge-slots.json'));
        else writeFileSync(join(dir, 'forge-slots.json'), text);
        const result = run(dir, {}, python);
        expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain('forge-slots:');
      }
    });
  }
  it('a lower setting preserves all installed slots and exports the retained count', () => {
    const dir = fixture();
    const pool = join(dir, 'pool'); mkdirSync(pool);
    for (const k of [9, 14, 11]) mkdirSync(join(pool, 'slot-' + k));
    const guard = setup.slice(setup.indexOf('set -euo pipefail'), setup.indexOf('if ! id forge-exec'))
      .replaceAll('/srv/forge-exec', pool);
    writeFileSync(join(dir, 'forge-setup.sh'), guard + `\nbash -c 'printf "%s" "$FORGE_EXEC_SLOTS"'\n`);
    const result = spawnSync('/bin/bash', [join(dir, 'forge-setup.sh')], {
      encoding: 'utf8', timeout: 10000, env: {PATH: process.env.PATH, FORGE_HOST: 'forge-b'},
    });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('14');
    expect(result.stderr).toContain('forge-slots.json host/default setting');
    expect(result.stderr).toContain('keeping 14 installed slots');
  });
  it('setup passes its effective count into both sweep and egress units', () => {
    expect(setup).toContain('Environment=FORGE_EXEC_SLOTS=$FORGE_EXEC_SLOTS');
    expect(setup).toContain(`printf 'Environment=FORGE_EXEC_SLOTS=%s\\n' "$FORGE_EXEC_SLOTS" >> /etc/systemd/system/forge-exec-sweep.service`);
  });
  it.each([128, 129])('setup revalidates retained slot-%i before any provisioning', count => {
    const dir = fixture();
    const pool = join(dir, 'pool'); mkdirSync(pool); mkdirSync(join(pool, `slot-${count}`));
    const guard = setup.slice(setup.indexOf('set -euo pipefail'), setup.indexOf('if ! id forge-exec'))
      .replaceAll('/srv/forge-exec', pool);
    writeFileSync(join(dir, 'forge-setup.sh'), guard + '\nprintf "provisioning"\n');
    const result = spawnSync('/bin/bash', [join(dir, 'forge-setup.sh')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: {PATH: process.env.PATH, FORGE_HOST: 'forge-b'},
    });
    expect(result.status, result.stderr).toBe(count > 128 ? 1 : 0);
    expect(result.stdout).toBe(count > 128 ? '' : 'provisioning');
    if (count > 128) expect(result.stderr).toContain('forge-setup: FORGE_EXEC_SLOTS must be 1..128');
  });
  it.each([
    ['installed users', 14, 11, {}, 14],
    ['installed paths', 11, 14, {}, 14],
    ['larger resolved count', 4, 6, {FORGE_HOST: 'forge'}, 14],
    ['explicit count', 14, 14, {FORGE_EXEC_SLOTS: '8'}, 8],
    ['UID override', 14, 14, {FORGE_EGRESS_UIDS: '999'}, 0],
    ['unreadable user database', 14, 14, {PASSWD_FAIL: '1'}, -1],
    ['missing retained user', 14, 14, {MISSING_SLOT: '14'}, -1],
  ])('standalone egress respects %s', (_, users, paths, overrides, count) => {
    const dir = fixture();
    const pool = join(dir, 'pool'); mkdirSync(pool); mkdirSync(join(pool, `slot-${paths}`));
    writeFileSync(join(dir, 'forge-egress.sh'), readFileSync(join(source, 'forge-egress.sh'), 'utf8')
      .replaceAll('/srv/forge-exec', pool));
    writeFileSync(join(dir, 'getent'), `#!/bin/bash\n[[ -z "\${PASSWD_FAIL:-}" ]] || exit 1\nprintf 'test-slot-${users}:x:2014:2014::/:/bin/false\\n'\n`, {mode: 0o755});
    writeFileSync(join(dir, 'id'), '#!/bin/bash\nk=${2##*-}\n[[ "$k" != "${MISSING_SLOT:-}" ]] || exit 1\necho $((2000 + k))\n', {mode: 0o755});
    const result = spawnSync('/bin/bash', [join(dir, 'forge-egress.sh'), 'render'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      env: {PATH: dir + ':' + process.env.PATH, FORGE_HOST: 'forge-b', FORGE_EGRESS_USER_PREFIX: 'test-slot-',
        FORGE_EGRESS_STATE_DIR: join(dir, 'state'), FORGE_EGRESS_REGISTRY_V4: '', FORGE_EGRESS_REGISTRY_V6: '', ...overrides},
    });
    expect(result.status, result.stderr).toBe(count < 0 ? 1 : 0);
    if (count < 0) expect(result.stdout).toBe('');
    else expect(result.stdout).toContain(`meta skuid { ${count === 0 ? '999' : Array.from({length: count}, (_, i) => 2001 + i).join(', ')} } jump slot_egress`);
  });
});
