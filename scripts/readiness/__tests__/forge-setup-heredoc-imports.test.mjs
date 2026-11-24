// @vitest-environment node
import {it, expect} from 'vitest';
import {readFileSync, mkdtempSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const source = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
const heredocs = [...source.matchAll(/^([^\n]*\bnode --input-type=module[^\n]*?)\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)^\2\s*$/gm)]
  .map(([, command, marker, body]) => ({command, marker, body}));

it('no module heredoc imports names from the installed bundle or a non-export of the source', async () => {
  for (const {marker, body} of heredocs) {
    for (const [, names, spec] of body.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      // The installed CLI bundle strips exports, even when its source exports them.
      expect(spec.startsWith('/usr/local/libexec/'), `${marker}: named import from installed CLI ${spec}`).toBe(false);
      if (spec.startsWith('node:')) continue;
      const module = await import(new URL('../' + basename(spec), import.meta.url).href);
      for (const binding of names.split(',')) {
        const name = binding.trim().split(/\s+as\s+|\s*:\s*/)[0];
        expect(Object.hasOwn(module, name), `${marker}: ${name} is not exported by ${spec}`).toBe(true);
      }
    }
  }
});

it('the egress check runs the installed runner CLI and the bundle built as forge-setup builds it reaches egressReady', () => {
  expect(source).not.toContain("<<'EGRESS_CHECK'");
  const check = source.match(/^\/usr\/local\/libexec\/forge-exec-run\.mjs egress-self-check "\$\{slot_uids\[@\]\}"$/m);
  expect(check).not.toBeNull();
  expect(source.indexOf(check[0])).toBeLessThan(source.indexOf("<<'ENABLE_SLOTS'"));
  // Run the REAL bundle() function from the WRAPPER step, writing to a scratch dir.
  const start = source.indexOf('        import re, json');
  const end = source.indexOf('        installed = [');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const dir = mkdtempSync(join(tmpdir(), 'forge-bundle-'));
  const here = fileURLToPath(new URL('..', import.meta.url));
  const py = 'import os, sys\nsource_dir = sys.argv[1]\n' + source.slice(start, end).split('\n').map(l => l.slice(8)).join('\n')
    + '\nopen(sys.argv[2], "w").write(bundle("forge-exec-run.mjs"))\n';
  const pyFile = join(dir, 'bundle.py');
  writeFileSync(pyFile, py);
  const out = join(dir, 'forge-exec-run.mjs');
  const built = spawnSync('python3', ['-I', pyFile, here, out], {encoding: 'utf8', timeout: 30000});
  expect(built.status, built.stderr).toBe(0);
  expect(readFileSync(out, 'utf8')).not.toMatch(/^export /m);
  // Bad uid: rejected by the self-check itself, proving the flag exists in the bundle.
  const bad = spawnSync('node', [out, 'egress-self-check', 'x'], {encoding: 'utf8', timeout: 30000});
  expect(bad.stderr).toContain('Invalid egress-self-check uids');
  // Good uid: must reach egressReady, which fails closed here (no forge egress table on a test host).
  const good = spawnSync('node', [out, 'egress-self-check', '101'], {encoding: 'utf8', timeout: 30000});
  expect(good.status).not.toBe(0);
  expect(good.stderr).toMatch(/Egress (table|rules)/);
});

it('validates pending sudoers before publishing the final sudoers file', () => {
  expect(source).toContain('set -euo pipefail');
  const validate = source.indexOf('visudo -cf "$sudoers_pending"');
  const publish = source.indexOf('os.replace(sys.argv[1], "/etc/sudoers.d/forge-exec")');
  expect(validate).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(validate);
  expect(source).toContain('python3 - "$sudoers_pending" <<\'ENABLE_SLOTS\'');
});

it('creates slot users with private groups and rejects shared or supplementary groups', () => {
  const slotUseradds = source.match(/^\s*useradd[^\n]*"forge-exec-\$k"$/gm);
  expect(slotUseradds).toHaveLength(1);
  expect(slotUseradds[0]).toContain('--user-group');
  expect(slotUseradds[0]).not.toMatch(/(?:^|\s)(?:-g|-G|--gid|--groups)(?:\s|=)/);
  expect(source).toContain('worker.pw_gid != group.gr_gid or worker.pw_uid in identities or group.gr_gid in groups');
  expect(source).toContain('if group.gr_mem or worker.pw_gid in os.getgrouplist("ops", ops.pw_gid):');
  expect(source).toContain('if set(os.getgrouplist("forge-exec-" + str(k), worker.pw_gid)) != {worker.pw_gid}:');
});

it('guards both useradd commands and tolerates existing service directories on retry', () => {
  const guarded = [...source.matchAll(/if ! id ([^\n]+) >\/dev\/null 2>&1; then\n\s*(useradd[^\n]+)\n\s*fi/g)];
  expect(guarded.map(([, user]) => user)).toEqual(['"forge-exec-$k"', 'forge-exec']);
  expect(source.match(/^\s*useradd\b/gm)).toHaveLength(guarded.length);
  expect(source).toMatch(/os\.mkdir\("forge-exec",[^\n]+\n\s*except FileExistsError:\n\s*pass/);
  expect(source).toMatch(/for name, uid, group, mode in \[\("forge-receipts",[\s\S]*?os\.mkdir\(name,[^\n]+\n\s*except FileExistsError:\n\s*pass/);
});

it('rewrites fixed unit paths and enables the same unit names on retry', () => {
  const units = [...source.matchAll(/^cat > (\/etc\/systemd\/system\/[^\s]+) <</gm)].map(([, path]) => path);
  expect(units.length).toBeGreaterThan(0);
  expect(new Set(units).size).toBe(units.length);
  expect(units.every(path => !path.includes('$'))).toBe(true);
  expect(source).toContain('if [[ "$load_state" != not-found ]]; then');
  for (const timer of ['forge-warm-base', 'forge-cache-prune', 'forge-exec-sweep', 'forge-exec-egress']) {
    expect(units).toContain(`/etc/systemd/system/${timer}.timer`);
    expect(source).toContain(`systemctl enable --now ${timer}.timer`);
  }
});
