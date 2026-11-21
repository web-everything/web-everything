// @vitest-environment node
import {it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';

const source = readFileSync(new URL('../forge-setup.sh', import.meta.url), 'utf8');
const heredocs = [...source.matchAll(/^([^\n]*\bnode --input-type=module[^\n]*?)\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)^\2\s*$/gm)]
  .map(([, command, marker, body]) => ({command, marker, body}));

it('finds module heredocs and verifies every named import against real source exports', async () => {
  expect(heredocs.length).toBeGreaterThan(0);
  let checked = 0;
  for (const {marker, body} of heredocs) {
    const imports = [
      ...[...body.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
        .map(([, names, spec]) => ({names, spec, dynamic: false})),
      ...[...body.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\(([\s\S]*?forge-exec-run\.mjs[\s\S]*?)\);/g)]
        .map(([, names, spec]) => ({names, spec, dynamic: true})),
    ];
    for (const {names, spec, dynamic} of imports) {
      const module = await import(dynamic ? '../forge-exec-run.mjs'
        : spec.startsWith('node:') ? spec : new URL('../' + basename(spec), import.meta.url).href);
      for (const binding of names.split(',')) {
        const name = binding.trim().split(/\s+as\s+|\s*:\s*/)[0];
        expect(Object.hasOwn(module, name), `${marker}: ${name} is not exported by ${spec}`).toBe(true);
        checked++;
      }
      // The installed CLI bundle strips exports, even when its source exports them.
      expect(spec.startsWith('/usr/local/libexec/'), `${marker}: named import from installed CLI ${spec}`).toBe(false);
    }
  }
  expect(checked).toBeGreaterThan(0);
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

it('checks every UID with the source runner and fails closed before sudoers publication', async () => {
  const egress = heredocs.find(({marker}) => marker === 'EGRESS_CHECK');
  expect(egress).toBeDefined();
  expect(egress.command).toContain('"$(cd -- "$(dirname -- "$0")" && pwd)" "${slot_uids[@]}"');
  expect(egress.body).toContain("pathToFileURL(path.join(dir, 'forge-exec-run.mjs')).href");
  expect(source.indexOf("<<'EGRESS_CHECK'")).toBeLessThan(source.indexOf("<<'ENABLE_SLOTS'"));
  // Inject only the runner factory; execute the actual argv slicing and probe loop.
  const body = egress.body
    .replace(/^import[^\n]+;\n/gm, '')
    .replace(/^const \{createRunner\} = await import\([^\n]+;\n/gm, '');
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('process', 'createRunner', body);
  const argv = ['node', '-', '/repo/scripts/readiness', '101', '102', '103'];
  const egressReady = vi.fn().mockResolvedValue(undefined);
  await run({argv}, () => ({egressReady}));
  expect(egressReady.mock.calls).toEqual([[101], [102], [103]]);
  egressReady.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('uncovered UID'));
  await expect(run({argv}, () => ({egressReady}))).rejects.toThrow('uncovered UID');
  expect(egressReady.mock.calls).toEqual([[101], [102]]);
});
