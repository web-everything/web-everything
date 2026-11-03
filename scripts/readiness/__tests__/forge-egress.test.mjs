// @vitest-environment node
// R497 step 3: the generated nftables rule set drops slot-user egress except loopback and the npm registry.
import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const script=join(here,'..','forge-egress.sh');
const render=(env={})=>spawnSync('bash',[script,'render'],{encoding:'utf8',env:{PATH:process.env.PATH,...env}});
const base={FORGE_EGRESS_UIDS:'990 991 992',FORGE_EGRESS_REGISTRY_V4:'104.16.1.35 104.16.2.35',FORGE_EGRESS_REGISTRY_V6:'2606:4700::6810:2323'};

describe('forge-egress rule set',()=>{
  it('matches exactly the slot uids and rejects everything but loopback and registry:443',()=>{
    const r=render(base);expect(r.status).toBe(0);
    expect(r.stdout).toContain('meta skuid { 990, 991, 992 } jump slot_egress');
    const chain=r.stdout.split('chain slot_egress {')[1].split('}')[0].trim().split('\n').map(l=>l.trim());
    expect(chain).toEqual(['oifname "lo" accept','ip daddr @registry4 tcp dport 443 accept','ip6 daddr @registry6 tcp dport 443 accept','reject with icmpx type admin-prohibited']);
    expect(r.stdout).toContain('elements = { 104.16.1.35, 104.16.2.35 }');
    expect(r.stdout).toContain('elements = { 2606:4700::6810:2323 }');
  });
  it('is one atomic transaction that replaces any previous table',()=>{
    const lines=render(base).stdout.split('\n');
    expect(lines.slice(0,2)).toEqual(['add table inet forge_exec_egress','delete table inet forge_exec_egress']);
    expect(lines[2]).toBe('table inet forge_exec_egress {');
  });
  it('never touches other users: policy accept, jump only for the uid set',()=>{
    const out=render(base).stdout;
    expect(out).toContain('type filter hook output priority 0; policy accept;');
    expect(out.match(/jump slot_egress/g)).toHaveLength(1);
  });
  it('fails closed (empty allowlist) when the registry does not resolve',()=>{
    const out=render({FORGE_EGRESS_UIDS:'990',FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:''}).stdout;
    expect(out).not.toContain('elements');
    expect(out).toContain('reject with icmpx');
  });
  it('aborts (no partial uid set) when any slot user lookup fails',()=>{
    // No FORGE_EGRESS_UIDS override: forge-exec-1.. do not exist on the test host, so id -u fails.
    const r=spawnSync('bash',[script,'render'],{encoding:'utf8',env:{PATH:process.env.PATH,FORGE_EXEC_SLOTS:'2',FORGE_EGRESS_USER_PREFIX:'no-such-slot-user-',FORGE_EGRESS_REGISTRY_V4:'1.1.1.1',FORGE_EGRESS_REGISTRY_V6:''}});
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('meta skuid');
  });
  it('apply loads the freshly rendered table even when DNS fails (closed allowlist, never a stale live table)',()=>{
    const dir=mkdtempSync(join(tmpdir(),'egress-nft-'));
    try {
      writeFileSync(join(dir,'nft'),'#!/bin/bash\n{ echo "ARGS:$*"; cat; } > "$NFT_CAPTURE"\n',{mode:0o755});
      const capture=join(dir,'captured');
      const r=spawnSync('bash',[script,'apply'],{encoding:'utf8',env:{PATH:dir+':'+process.env.PATH,NFT_CAPTURE:capture,FORGE_EGRESS_UIDS:'990',FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:''}});
      expect(r.status).toBe(0);
      const got=readFileSync(capture,'utf8');
      expect(got).toContain('ARGS:-f -');
      expect(got).toContain('delete table inet forge_exec_egress');
      expect(got).not.toContain('elements');
      expect(got).toContain('reject with icmpx');
      expect(got).not.toContain('keeping the live table');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('apply never calls nft when the slot uid lookup fails',()=>{
    const dir=mkdtempSync(join(tmpdir(),'egress-nft-'));
    try {
      writeFileSync(join(dir,'nft'),'#!/bin/bash\ntouch "$NFT_CAPTURE"\n',{mode:0o755});
      const capture=join(dir,'called');
      const r=spawnSync('bash',[script,'apply'],{encoding:'utf8',env:{PATH:dir+':'+process.env.PATH,NFT_CAPTURE:capture,FORGE_EXEC_SLOTS:'2',FORGE_EGRESS_USER_PREFIX:'no-such-slot-user-',FORGE_EGRESS_REGISTRY_V4:'1.1.1.1'}});
      expect(r.status).not.toBe(0);
      expect(existsSync(capture)).toBe(false);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('boot ordering: egress service runs before sshd and refreshes after 1 minute',()=>{
    const setup=readFileSync(join(here,'..','forge-setup.sh'),'utf8');
    expect(setup).toContain('Before=ssh.service sshd.service');
    expect(setup).toContain('OnBootSec=1min');
  });
  it('refuses to render with no slot uids',()=>{
    expect(render({...base,FORGE_EGRESS_UIDS:''}).status).not.toBe(0);
  });
  it('forge-setup installs and enables it, and documents rollback',()=>{
    const setup=readFileSync(join(here,'..','forge-setup.sh'),'utf8');
    expect(setup).toContain('forge-egress.sh');
    expect(setup).toContain('systemctl enable --now forge-exec-egress.timer');
    expect(setup).toContain('nft delete table inet forge_exec_egress');
  });
});
