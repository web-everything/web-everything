// @vitest-environment node
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, symlinkSync, existsSync, readdirSync} from 'node:fs';
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
  it.each(['physical', 'directory symlink', 'file symlink'])(
    'Node CLI resolves settings and validates overrides through a %s path', kind => {
      const dir = fixture();
      let entry = join(dir, 'forge-slots.mjs');
      if (kind === 'directory symlink') {
        symlinkSync(dir, join(dir, 'deployment'), 'dir');
        entry = join(dir, 'deployment', 'forge-slots.mjs');
      } else if (kind === 'file symlink') {
        symlinkSync('forge-slots.mjs', join(dir, 'reader.mjs'));
        entry = join(dir, 'reader.mjs');
      }
      for (const [overrides, status, stdout] of [
        [{}, 0, '14\n'], [{FORGE_EXEC_SLOTS: '12'}, 0, '12\n'], [{FORGE_EXEC_SLOTS: '129'}, 1, ''],
      ]) {
        const result = spawnSync(process.execPath, [entry], {
          encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
          env: {PATH: process.env.PATH, FORGE_HOST: 'forge', ...overrides},
        });
        expect(result.status, result.stderr).toBe(status);
        expect(result.stdout).toBe(stdout);
        if (status) expect(result.stderr).toContain('FORGE_EXEC_SLOTS must be 1..128');
      }
    });
  it.each([undefined, '/nonexistent-forge-slots-entry.mjs'])(
    'import stays silent with argv[1]=%s', argv => {
      const dir = fixture();
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `process.argv[1] = ${JSON.stringify(argv) ?? 'undefined'}; await import(${JSON.stringify(join(dir, 'forge-slots.mjs'))}); console.log('imported');`], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: {PATH: process.env.PATH, FORGE_HOST: 'forge'},
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('imported\n');
      expect(result.stderr).toBe('');
    });
  it('setup resolves its host setting through a symlinked deployment directory before provisioning', () => {
    const dir = fixture(), pool = join(dir, 'pool');
    mkdirSync(pool);
    symlinkSync(dir, join(dir, 'deployment'), 'dir');
    const guard = setup.slice(setup.indexOf('set -euo pipefail'), setup.indexOf('# Preflight egress'))
      .replaceAll('/srv/forge-exec', pool);
    writeFileSync(join(dir, 'forge-setup.sh'), guard + '\nprintf "%s\\n" "$FORGE_EXEC_SLOTS"\n');
    const result = spawnSync('/bin/bash', [join(dir, 'deployment', 'forge-setup.sh')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: {PATH: process.env.PATH, FORGE_HOST: 'forge'},
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('14\n');
    expect(result.stderr).toContain('FORGE_EXEC_SLOTS=14 (forge-slots.json host/default setting)');
  });
  for (const python of [false, true]) {
    const reader = python ? 'Python fallback without Node' : 'Node CLI';
    it(`${reader}: copied flat deployment reads the same JSON and FORGE_HOST`, () => {
      const result = run(fixture(), {FORGE_HOST: 'forge'}, python);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('14\n');
    });
    it(`${reader}: symlinked checkout reads settings from the sibling settings directory`, () => {
      const dir = fixture(), checkout = join(dir, 'checkout');
      mkdirSync(join(checkout, 'settings'), {recursive: true});
      mkdirSync(join(checkout, 'readiness'));
      for (const file of ['forge-slots.mjs', 'forge-slots.sh']) cpSync(join(dir, file), join(checkout, 'readiness', file));
      cpSync(join(dir, 'forge-slots.json'), join(checkout, 'settings', 'forge-slots.json'));
      symlinkSync(checkout, join(dir, 'deployment'), 'dir');
      const result = run(join(dir, 'deployment', 'readiness'), {FORGE_HOST: 'forge'}, python);
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
    const guard = setup.slice(setup.indexOf('set -euo pipefail'), setup.indexOf('# Preflight egress'))
      .replaceAll('/srv/forge-exec', pool);
    writeFileSync(join(dir, 'forge-setup.sh'), guard + `\nbash -c 'printf "%s" "$FORGE_EXEC_SLOTS"'\n`);
    const result = spawnSync('/bin/bash', [join(dir, 'forge-setup.sh')], {
      encoding: 'utf8', timeout: 10000, env: {PATH: process.env.PATH, FORGE_HOST: 'forge-b'},
    });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('14');
    expect(result.stderr).toContain('forge-slots.json host/default setting');
    expect(result.stderr).toContain('keeping 14 installed slots');
  });
  it.each([true, false])('14 installed accounts with 8 directories: explicit limit=%s refuses before publication; settings retain installed count', explicit => {
    const dir = fixture(), pool = join(dir, 'pool'), sudoers = join(dir, 'sudoers'), log = join(dir, 'log');
    mkdirSync(pool);
    const slots = Array.from({length: 8}, (_, i) => `slot-${i + 1}`);
    for (const slot of slots) mkdirSync(join(pool, slot));
    const fake = (name, body) => writeFileSync(join(dir, name), '#!/bin/bash\n' + body + '\n', {mode: 0o755});
    fake('getent', 'for k in {1..14}; do echo "forge-exec-$k:x:$((2000+k)):2000::/:/bin/bash"; done');
    // Stop safely and record any attempt to proceed beyond the count guards.
    for (const name of ['python3', 'apt-get', 'systemctl', 'useradd']) fake(name, 'echo "$0 $*" >> "$LOG"; exit 99');
    const script = explicit ? setup : setup.slice(0, setup.indexOf('# Pick unused system UIDs'))
      + `\nbash -c 'printf "%s" "$FORGE_EXEC_SLOTS"'\n`;
    writeFileSync(join(dir, 'forge-setup.sh'), script.replaceAll('/srv/forge-exec', pool)
      .replaceAll('/etc/sudoers.d/forge-exec', sudoers));
    const result = spawnSync('/bin/bash', [join(dir, 'forge-setup.sh')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      env: {PATH: dir + ':' + process.env.PATH, FORGE_HOST: 'forge-b', LOG: log,
        ...(explicit ? {FORGE_EXEC_SLOTS: '8'} : {})},
    });
    expect(result.status, result.stderr).toBe(explicit ? 1 : 0);
    expect(result.stdout).toBe(explicit ? '' : '14');
    if (explicit) expect(result.stderr).toContain('cannot shrink an installed pool; retain its slot count and inspect reservations');
    else expect(result.stderr).toContain('forge-slots.json host/default setting');
    expect(readdirSync(pool).sort()).toEqual(slots.sort());
    expect(existsSync(sudoers)).toBe(false);
    expect(existsSync(log)).toBe(false);
  });
  it.each(['success', 'egress-failure', 'after-egress-failure'])('grow 8 to 14 covers planned UIDs before publishing slots: %s', failure => {
    const dir = fixture(), pool = join(dir, 'pool'), log = join(dir, 'log');
    mkdirSync(pool);
    for (let k = 1; k <= 8; k++) mkdirSync(join(pool, `slot-${k}`));
    const fake = (name, body) => writeFileSync(join(dir, name), '#!/bin/bash\n' + body + '\n', {mode: 0o755});
    fake('getent', `for k in {1..8}; do echo "forge-exec-$k:x:$((2000+k)):2000::/:/bin/bash"; done`);
    fake('systemctl', 'echo not-found');
    fake('nft', 'exit 0');
    fake('id', '[[ "$1" == forge-exec ]] && exit 0; k=${1##*-}; ((k <= 8))');
    fake('useradd', `echo "publish:$*" >> "$LOG"`);
    writeFileSync(join(dir, 'login.defs'), 'SYS_UID_MIN 100\nSYS_UID_MAX 999\n');
    writeFileSync(join(dir, 'forge-egress.sh'), `echo "egress:$FORGE_EGRESS_UIDS" >> "$LOG"
[[ "$FAILURE" != egress-failure ]] || exit 1
[[ "$FAILURE" != after-egress-failure ]] || touch "$FAIL_AFTER"
`);
    // Execute the actual setup prefix through account publication, with host IO stubbed.
    const prefix = setup.slice(setup.indexOf('set -euo pipefail'), setup.indexOf('# Only ops may create run containers.'))
      .replaceAll('/srv/forge-exec', pool).replace('/etc/login.defs', join(dir, 'login.defs'))
      .replace('# Only after the complete target pool', '[[ ! -e "$FAIL_AFTER" ]] || exit 1\n# Only after the complete target pool');
    writeFileSync(join(dir, 'forge-setup.sh'), prefix);
    const result = spawnSync('/bin/bash', [join(dir, 'forge-setup.sh')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      env: {PATH: dir + ':' + process.env.PATH, FORGE_EXEC_SLOTS: '14', LOG: log, FAILURE: failure, FAIL_AFTER: join(dir, 'fail-after')},
    });
    expect(result.status, result.stderr).toBe(failure === 'success' ? 0 : 1);
    const events = readFileSync(log, 'utf8').trim().split('\n');
    expect(events[0]).toBe('egress:2001 2002 2003 2004 2005 2006 2007 2008 999 998 997 996 995 994');
    expect(events.slice(1)).toHaveLength(failure === 'success' ? 6 : 0);
    if (failure === 'success') expect(events[1]).toContain('--uid 999');
    expect(events.some(line => line.includes('sudoers'))).toBe(false);
  });
  it.each([
    ['active', 'stop', false],
    ['active', 'service', false],
    ['active', 'sudoers', false],
    ['active', 'later', false],
    ['active', 'later', true],
    ['active', 'enable', false],
    ['inactive', 'later', false],
    ['not-found', 'later', false],
    ['active', 'success', false],
    ['inactive', 'success', false],
  ])('setup restores timer state without masking errors: %s / %s / restart failure=%s', (state, stage, restartFails) => {
    const dir = fixture(), log = join(dir, 'log'), pending = join(dir, 'sudoers-pending');
    const fake = (name, body) => writeFileSync(join(dir, name), '#!/bin/bash\n' + body + '\n', {mode: 0o755});
    fake('systemctl', `echo "$*" >> "$LOG"
if [[ "$1" == show ]]; then
  if [[ "$3" == LoadState && "$STATE" != not-found ]]; then echo loaded; else echo "$STATE"; fi
elif [[ "$1" == stop && "$STAGE" == stop ]] ||
     [[ "$1 $2" == 'start forge-exec-egress.service' && "$STAGE" == service ]] ||
     [[ "$1" == enable && "$STAGE" == enable ]]; then exit 37
elif [[ "$1 $2" == 'start forge-exec-egress.timer' && "$RESTART_FAILS" == true ]]; then exit 9
fi`);
    fake('mktemp', 'touch "$PENDING"; printf "%s\\n" "$PENDING"');
    fake('visudo', '[[ "$STAGE" != sudoers ]] || exit 37');
    fake('chown', 'exit 0');
    const timer = setup.slice(setup.indexOf('# Missing units are normal'), setup.indexOf('if ! command -v nft'));
    const sudoers = setup.slice(setup.indexOf('sudoers_pending=$(mktemp'), setup.indexOf('if ! command -v rsync'))
      .replace('/etc/sudoers.d/forge-exec', join(dir, 'sudoers'));
    const success = setup.slice(setup.lastIndexOf('systemctl enable --now forge-exec-egress.timer'), setup.indexOf('# Verify the installed runner'));
    writeFileSync(join(dir, 'forge-setup.sh'), `set -euo pipefail\nFORGE_EXEC_SLOTS=1\n${timer}\n${sudoers}\n[[ "$STAGE" != later ]] || exit 37\n${success}`);
    const result = spawnSync('/bin/bash', [join(dir, 'forge-setup.sh')], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      env: {PATH: dir + ':' + process.env.PATH, LOG: log, PENDING: pending, STATE: state, STAGE: stage, RESTART_FAILS: String(restartFails)},
    });
    expect(result.status, result.stderr).toBe(stage === 'success' ? 0 : 37);
    const events = readFileSync(log, 'utf8').trim().split('\n');
    expect(events.includes('start forge-exec-egress.timer')).toBe(state === 'active' && stage !== 'success');
    expect(events.includes('enable --now forge-exec-egress.timer')).toBe(['success', 'enable'].includes(stage));
    expect(events.includes('stop forge-exec-egress.service')).toBe(false);
    expect(result.stderr.includes('restart it manually')).toBe(restartFails);
    expect(() => readFileSync(pending)).toThrow();
  });
  it.each(['after-accounts', 'after-egress-install', 'before-enable', 'apply-failure', 'check-failure', 'publish-failure', 'success'])(
    'two-phase grow keeps slots 9–14 disabled until verified egress: %s', stage => {
      const dir = fixture(), srv = join(dir, 'srv'), pool = join(srv, 'forge-exec');
      const log = join(dir, 'log'), sudoers = join(dir, 'sudoers');
      mkdirSync(pool, {recursive: true});
      for (let k = 1; k <= 8; k++) mkdirSync(join(pool, `slot-${k}`), {mode: 0o710});
      const oldSudoers = 'ops ALL=(' + Array.from({length: 8}, (_, i) => `forge-exec-${i + 1}`).join(',') + ') NOPASSWD: /usr/bin/rsync\n';
      writeFileSync(sudoers, oldSudoers);
      const fake = (name, body) => writeFileSync(join(dir, name), '#!/bin/bash\n' + body + '\n', {mode: 0o755});
      fake('getent', 'for k in {1..8}; do echo "forge-exec-$k:x:$((2000+k)):2000::/:/bin/bash"; done');
      fake('id', '[[ "$1" == forge-exec ]] && exit 0; k=${1##*-}; ((k <= 8))');
      fake('useradd', 'echo "account:$*" >> "$LOG"');
      fake('systemctl', 'if [[ "$1" == show ]]; then [[ "$3" == LoadState ]] && echo loaded || echo active; else echo "timer:$*" >> "$LOG"; fi');
      fake('nft', 'exit 0'); fake('chown', 'exit 0'); fake('visudo', 'exit 0');
      writeFileSync(join(dir, 'login.defs'), 'SYS_UID_MIN 100\nSYS_UID_MAX 999\n');
      writeFileSync(join(dir, 'forge-egress.sh'), 'echo "apply:$FORGE_EGRESS_UIDS" >> "$LOG"\n[[ "$STAGE" != apply-failure || ! -e "$READY" ]]\n');
      // UID coverage semantics are covered in forge-exec-egress-table.test.mjs.
      // Here the command boundary verifies that setup has not enabled anything yet.
      fake('node', `echo 'check' >> "$LOG"
for k in {9..14}; do [[ ! -e "$POOL/slot-$k" ]] || exit 90; done
[[ "$STAGE" != check-failure ]]`);
      const prefix = setup.slice(setup.indexOf('set -euo pipefail'), setup.indexOf('# Only ops may create run containers.'));
      const body = setup.match(/python3 - <<'DIRECTORIES'\n([\s\S]*?)\nDIRECTORIES/)[1];
      const identities = `import os, pwd, grp, types
original_fstat = os.fstat
os.fstat = lambda fd: types.SimpleNamespace(st_uid=0, st_mode=original_fstat(fd).st_mode)
os.fchown = lambda *args: None
os.getgrouplist = lambda name, gid: [gid]
pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=2000+int(name.rsplit('-', 1)[1]) if name.startswith('forge-exec-') else 1000, pw_gid=3000+int(name.rsplit('-', 1)[1]) if name.startswith('forge-exec-') else 1000)
grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=3000+int(name.rsplit('-', 1)[1]) if name.startswith('forge-exec-') else 1000, gr_mem=[])
`;
      const prepare = setup.slice(setup.indexOf('sudoers_pending=$(mktemp'), setup.indexOf('if ! command -v rsync'));
      const enable = setup.slice(setup.lastIndexOf('systemctl enable --now forge-exec-egress.timer'))
        .replace('/usr/local/libexec/forge-egress.sh apply', 'bash "$(dirname -- "$0")/forge-egress.sh" apply')
        .replace('# Final enable:', '[[ "$STAGE" != before-enable ]] || exit 37\n# Final enable:')
        .replace('import os, sys\nroot =', `import os, sys
if os.environ['STAGE'] == 'publish-failure':
    def fail_replace(*args): raise OSError('simulated sudoers publication failure')
    os.replace = fail_replace
root =`);
      // Use the real account, directory, sudoers preparation and final-enable code;
      // replace unrelated package/runtime installation with explicit failure points.
      const script = `${prefix}
[[ "$STAGE" != after-accounts ]] || exit 37
python3 - <<'DIRECTORIES'
${identities}${body}
DIRECTORIES
${prepare}
echo egress-installed >> "$LOG"
touch "$READY"
[[ "$STAGE" != after-egress-install ]] || exit 37
${enable}`.replaceAll('/srv', srv).replaceAll('/etc/login.defs', join(dir, 'login.defs'))
        .replaceAll('/etc/sudoers.d/.forge-exec.XXXXXXXX', join(dir, '.sudoers.XXXXXXXX'))
        .replaceAll('/etc/sudoers.d/forge-exec', sudoers);
      writeFileSync(join(dir, 'forge-setup.sh'), script);
      const result = spawnSync('/bin/bash', [join(dir, 'forge-setup.sh')], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
        env: {PATH: dir + ':' + process.env.PATH, FORGE_EXEC_SLOTS: '14', STAGE: stage, LOG: log, POOL: pool, READY: join(dir, 'installed')},
      });
      expect(result.status, result.stderr).toBe(stage === 'success' ? 0 : stage.includes('failure') ? 1 : 37);
      const usable = readdirSync(pool).filter(name => /^slot-[1-9]\d*$/.test(name));
      expect(usable).toHaveLength(stage === 'success' ? 14 : 8);
      for (let k = 9; k <= 14; k++) {
        expect(existsSync(join(pool, `slot-${k}`))).toBe(stage === 'success');
        expect(readFileSync(sudoers, 'utf8').includes(`forge-exec-${k}`)).toBe(stage === 'success');
      }
      const events = readFileSync(log, 'utf8').trim().split('\n');
      expect(events.filter(line => line.startsWith('account:'))).toHaveLength(6);
      const restoresTimer = ['after-accounts', 'after-egress-install'].includes(stage);
      expect(events.includes('timer:start forge-exec-egress.timer')).toBe(restoresTimer);
      expect(events.includes('timer:enable --now forge-exec-egress.timer')).toBe(!restoresTimer);
      if (stage === 'success') {
        expect(events.slice(-2)).toEqual(['apply:2001 2002 2003 2004 2005 2006 2007 2008 999 998 997 996 995 994', 'check']);
        expect(events.indexOf('egress-installed')).toBeLessThan(events.lastIndexOf('check'));
      } else expect(readFileSync(sudoers, 'utf8')).toBe(oldSudoers);
    });
  it('setup passes its effective count into both sweep and egress units', () => {
    expect(setup).toContain('Environment=FORGE_EXEC_SLOTS=$FORGE_EXEC_SLOTS');
    expect(setup).toContain(`printf 'Environment=FORGE_EXEC_SLOTS=%s\\n' "$FORGE_EXEC_SLOTS" >> /etc/systemd/system/forge-exec-sweep.service`);
  });
  it.each([128, 129])('setup revalidates retained slot-%i before any provisioning', count => {
    const dir = fixture();
    const pool = join(dir, 'pool'); mkdirSync(pool); mkdirSync(join(pool, `slot-${count}`));
    const guard = setup.slice(setup.indexOf('set -euo pipefail'), setup.indexOf('# Preflight egress'))
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
    ['explicit count covers installed users', 14, 11, {FORGE_EXEC_SLOTS: '8'}, 14],
    ['explicit count covers installed paths', 11, 14, {FORGE_EXEC_SLOTS: '8'}, 14],
    ['larger explicit count', 4, 6, {FORGE_EXEC_SLOTS: '16'}, 16],
    ['UID override', 14, 14, {FORGE_EGRESS_UIDS: '999'}, 0],
    ['unreadable user database', 14, 14, {PASSWD_FAIL: '1'}, -1],
    ['missing retained user', 14, 14, {MISSING_SLOT: '14'}, -1],
    ['explicit count with unreadable user database', 14, 14, {FORGE_EXEC_SLOTS: '8', PASSWD_FAIL: '1'}, -1],
    ['explicit count with missing retained user', 14, 14, {FORGE_EXEC_SLOTS: '8', MISSING_SLOT: '14'}, -1],
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
