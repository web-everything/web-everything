// @vitest-environment node
// R497 step 3: the generated nftables rule set drops slot-user egress except loopback and the npm registry.
import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync,mkdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const script=join(here,'..','forge-egress.sh');
const setupSrc=()=>readFileSync(join(here,'..','forge-setup.sh'),'utf8');
// Hermetic: never read the host's real /run state.
const NO_STATE={FORGE_EGRESS_STATE_DIR:'/nonexistent/forge-egress-state'};
const render=(env={})=>spawnSync('bash',[script,'render'],{encoding:'utf8',env:{PATH:process.env.PATH,...NO_STATE,...env}});
const base={FORGE_EGRESS_UIDS:'990 991 992',FORGE_EGRESS_REGISTRY_V4:'104.16.1.35 104.16.2.35',FORGE_EGRESS_REGISTRY_V6:'2606:4700::6810:2323'};
// A scratch dir holding fake executables (first on PATH) plus a per-test state dir.
const sandbox=(fn)=>{
  const dir=mkdtempSync(join(tmpdir(),'egress-'));
  try { return fn(dir); } finally { rmSync(dir,{recursive:true,force:true}); }
};
const fake=(dir,name,body)=>writeFileSync(join(dir,name),`#!/bin/bash\n${body}\n`,{mode:0o755});
const NFT_CAPTURE='{ echo "ARGS:$*"; cat; } > "$NFT_CAPTURE"';
const apply=(dir,env={})=>spawnSync('bash',[script,'apply'],{encoding:'utf8',env:{PATH:dir+':'+process.env.PATH,FORGE_EGRESS_STATE_DIR:join(dir,'default-state'),NFT_CAPTURE:join(dir,'captured'),...env}});
const captured=(dir)=>readFileSync(join(dir,'captured'),'utf8');
const elements=(text,set)=>{const m=text.match(new RegExp(`set ${set} \\{[^}]*?elements = \\{ ([^}]*) \\}`));return m?m[1].split(', ').sort():[];};

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
  it('refuses to render with no slot uids',()=>{
    expect(render({...base,FORGE_EGRESS_UIDS:''}).status).not.toBe(0);
  });
});

describe('forge-egress slot user lookup',()=>{
  it('aborts (no partial uid set) when any slot user lookup fails',()=>{
    // No FORGE_EGRESS_UIDS override: forge-exec-1.. do not exist on the test host, so id -u fails.
    const r=render({FORGE_EXEC_SLOTS:'2',FORGE_EGRESS_USER_PREFIX:'no-such-slot-user-',FORGE_EGRESS_REGISTRY_V4:'1.1.1.1',FORGE_EGRESS_REGISTRY_V6:''});
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('meta skuid');
  });
  it('apply never calls nft when the slot uid lookup fails',()=>sandbox(dir=>{
    fake(dir,'nft','touch "$NFT_CAPTURE"');
    const r=apply(dir,{NFT_CAPTURE:join(dir,'called'),FORGE_EXEC_SLOTS:'2',FORGE_EGRESS_USER_PREFIX:'no-such-slot-user-',FORGE_EGRESS_REGISTRY_V4:'1.1.1.1'});
    expect(r.status).not.toBe(0);
    expect(existsSync(join(dir,'called'))).toBe(false);
  }));
  it('discovers eight slot users by default (forge-exec-1..8)',()=>sandbox(dir=>{
    fake(dir,'id','[ "$1" = -u ] || exit 2; echo "$2" >> "$ID_LOG"; echo $((2000 + ${2##*-}))');
    const r=spawnSync('bash',[script,'render'],{encoding:'utf8',env:{PATH:dir+':'+process.env.PATH,ID_LOG:join(dir,'ids'),...NO_STATE,FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:''}});
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir,'ids'),'utf8').trim().split('\n')).toEqual([1,2,3,4,5,6,7,8].map(n=>`forge-exec-${n}`));
    expect(r.stdout).toContain('meta skuid { 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008 } jump slot_egress');
  }));
  it('aborts and never calls nft when slot 2 lookup fails after slot 1 succeeded',()=>sandbox(dir=>{
    fake(dir,'id','[ "$2" = forge-exec-1 ] && { echo 2001; exit 0; }; exit 1');
    fake(dir,'nft','touch "$NFT_CAPTURE"');
    const r=apply(dir,{NFT_CAPTURE:join(dir,'called'),FORGE_EXEC_SLOTS:'3',FORGE_EGRESS_REGISTRY_V4:'1.1.1.1',FORGE_EGRESS_REGISTRY_V6:''});
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('meta skuid');
    expect(existsSync(join(dir,'called'))).toBe(false);
    const rendered=spawnSync('bash',[script,'render'],{encoding:'utf8',env:{PATH:dir+':'+process.env.PATH,...NO_STATE,FORGE_EXEC_SLOTS:'3',FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:''}});
    expect(rendered.status).not.toBe(0);
    expect(rendered.stdout).not.toContain('2001');
  }));
});

describe('forge-egress registry lookup (default resolver path)',()=>{
  const slot={FORGE_EGRESS_UIDS:'990'};
  it('bounds registry lookup and applies an empty allowlist on resolver failure',()=>sandbox(dir=>{
    fake(dir,'getent','echo "getent $*" >> "$LOOKUP_LOG"; exit 2');
    fake(dir,'timeout','echo "timeout $*" >> "$LOOKUP_LOG"; shift; exec "$@"');
    fake(dir,'nft',NFT_CAPTURE);
    const r=apply(dir,{...slot,LOOKUP_LOG:join(dir,'lookups')});
    expect(r.status).toBe(0);
    const log=readFileSync(join(dir,'lookups'),'utf8');
    expect(log).toContain('timeout 5 getent ahostsv4 registry.npmjs.org');
    expect(log).toContain('timeout 5 getent ahostsv6 registry.npmjs.org');
    const got=captured(dir);
    expect(got).toContain('ARGS:-f -');
    expect(got).toContain('delete table inet forge_exec_egress');
    expect(got).not.toContain('elements');
    expect(got).toContain('reject with icmpx');
  }));
  it('applies an empty allowlist when the resolver times out',()=>sandbox(dir=>{
    fake(dir,'getent','echo 104.16.1.35 STREAM registry.npmjs.org');
    fake(dir,'timeout','exit 124');
    fake(dir,'nft',NFT_CAPTURE);
    expect(apply(dir,{...slot}).status).toBe(0);
    expect(captured(dir)).not.toContain('elements');
  }));
  it('installs the resolved, de-duplicated registry addresses from the default lookup',()=>sandbox(dir=>{
    fake(dir,'getent','case "$1" in ahostsv4) printf "104.16.1.35 STREAM registry.npmjs.org\\n104.16.1.35 DGRAM\\n104.16.2.35 STREAM\\n";; *) printf "2606:4700::6810:2323 STREAM registry.npmjs.org\\n";; esac');
    fake(dir,'timeout','shift; exec "$@"');
    fake(dir,'nft',NFT_CAPTURE);
    expect(apply(dir,{...slot}).status).toBe(0);
    const got=captured(dir);
    expect(elements(got,'registry4')).toEqual(['104.16.1.35','104.16.2.35']);
    expect(elements(got,'registry6')).toEqual(['2606:4700::6810:2323']);
  }));
  it('apply loads a freshly rendered table even when DNS fails (empty allowlist when no snapshot is retained)',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    const r=apply(dir,{...slot,FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:''});
    expect(r.status).toBe(0);
    const got=captured(dir);
    expect(got).toContain('delete table inet forge_exec_egress');
    expect(got).not.toContain('elements');
    expect(got).not.toContain('keeping the live table');
  }));
});

describe('forge-egress registry grace window (rotating CDN pool)',()=>{
  const slot={FORGE_EGRESS_UIDS:'990',FORGE_EGRESS_REGISTRY_V6:''};
  const run=(dir,state,v4,extra={})=>{
    const r=apply(dir,{...slot,FORGE_EGRESS_STATE_DIR:state,FORGE_EGRESS_REGISTRY_V4:v4,...extra});
    return {r,got:existsSync(join(dir,'captured'))?captured(dir):''};
  };
  it('keeps an address that stopped resolving for the next refreshes, then drops it',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    const state=join(dir,'state');
    expect(elements(run(dir,state,'1.1.1.1').got,'registry4')).toEqual(['1.1.1.1']);
    expect(elements(run(dir,state,'2.2.2.2').got,'registry4')).toEqual(['1.1.1.1','2.2.2.2']);
    expect(elements(run(dir,state,'3.3.3.3').got,'registry4')).toEqual(['1.1.1.1','2.2.2.2','3.3.3.3']);
    // KEEP=3: an address stays allowed for 3 refreshes after it last resolved, then ages out.
    expect(elements(run(dir,state,'4.4.4.4').got,'registry4')).toEqual(['1.1.1.1','2.2.2.2','3.3.3.3','4.4.4.4']);
    expect(elements(run(dir,state,'5.5.5.5').got,'registry4')).toEqual(['2.2.2.2','3.3.3.3','4.4.4.4','5.5.5.5']);
  }));
  it('a DNS blip keeps the previous allowlist and does not age the history',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    const state=join(dir,'state');
    run(dir,state,'1.1.1.1');
    for(let i=0;i<5;i++) expect(elements(run(dir,state,'').got,'registry4')).toEqual(['1.1.1.1']);
  }));
  it('does not record a snapshot when nft rejects the table',()=>sandbox(dir=>{
    fake(dir,'nft','cat >/dev/null; exit 1');
    const state=join(dir,'state');
    const {r}=run(dir,state,'9.9.9.9');
    expect(r.status).not.toBe(0);
    expect(existsSync(join(state,'registry4'))).toBe(false);
  }));
  it('history is not trusted text: only address characters reach the ruleset',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    const state=join(dir,'state');mkdirSync(state);
    writeFileSync(join(state,'registry4'),'1.1.1.1 };flush ruleset;{ 5.5.5.5\n$(touch pwned) 6.6.6.6\n');
    const {r,got}=run(dir,state,'');
    expect(r.status).toBe(0);
    expect(got).not.toContain('flush');
    expect(got).not.toContain('pwned');
    expect(elements(got,'registry4')).toEqual(['1.1.1.1','5.5.5.5','6.6.6.6']);
  }));
  it('malformed history tokens (not addresses of the family) never reach the ruleset',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    const state=join(dir,'state');mkdirSync(state);
    writeFileSync(join(state,'registry4'),'dead . : 2606:4700::1 300.1 1.2.3.4\n');
    writeFileSync(join(state,'registry6'),'add 1.2.3.4 2606:4700::1\n');
    const r=apply(dir,{FORGE_EGRESS_UIDS:'990',FORGE_EGRESS_STATE_DIR:state,FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:''});
    expect(r.status).toBe(0);
    const got=captured(dir);
    expect(elements(got,'registry4')).toEqual(['1.2.3.4']);
    expect(elements(got,'registry6')).toEqual(['2606:4700::1']);
  }));
  it('an invalid retention setting falls back to 3 snapshots',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    const state=join(dir,'state');
    for(const ip of ['1.1.1.1','2.2.2.2','3.3.3.3']) run(dir,state,ip,{FORGE_EGRESS_KEEP_SNAPSHOTS:'0; rm'});
    run(dir,state,'4.4.4.4',{FORGE_EGRESS_KEEP_SNAPSHOTS:'x'});
    expect(elements(run(dir,state,'5.5.5.5',{FORGE_EGRESS_KEEP_SNAPSHOTS:'-1'}).got,'registry4')).toEqual(['2.2.2.2','3.3.3.3','4.4.4.4','5.5.5.5']);
  }));
});

describe('forge-setup egress service',()=>{
  it('boot ordering: egress service runs before sshd and refreshes after 1 minute',()=>{
    const setup=setupSrc();
    expect(setup).toContain('Before=ssh.socket ssh.service sshd.service');
    expect(setup).toContain('OnBootSec=1min');
  });
  it('fail closed: ssh.service drop-in requires the egress service, written before daemon-reload',()=>{
    const setup=setupSrc();
    const m=setup.match(/ssh\.service\.d\/forge-egress\.conf <<'SSHDROPIN'\n([\s\S]*?)\nSSHDROPIN\n/);
    expect(m,'drop-in heredoc missing').not.toBeNull();
    const lines=m[1].split('\n');
    expect(lines).toEqual(['[Unit]','Requires=forge-exec-egress.service','After=forge-exec-egress.service']);
    // The drop-in exists before the reload that makes systemd read it, and before ssh could be restarted.
    const dropAt=setup.indexOf('ssh.service.d/forge-egress.conf <<');
    const reloadAt=setup.indexOf('systemctl daemon-reload',dropAt);
    expect(reloadAt).toBeGreaterThan(dropAt);
    expect(reloadAt).toBeLessThan(setup.indexOf('systemctl start forge-exec-egress.service'));
    expect(setup.indexOf('mkdir -p /etc/systemd/system/ssh.service.d')).toBeLessThan(dropAt);
  });
  it('setup installs and activates the egress service with five-minute refresh',()=>{
    const setup=setupSrc();
    const at=(s)=>{const i=setup.indexOf(s);expect(i,`missing: ${s}`).toBeGreaterThan(-1);return i;};
    // Root-owned, installed via temp file then atomic rename.
    expect(at('install -o root -g root -m 0755 "$(dirname -- "$0")/forge-egress.sh" "$egress_pending"'))
      .toBeLessThan(at('mv -f -- "$egress_pending" /usr/local/libexec/forge-egress.sh'));
    // The unit carries the slot count (a dropped line would fall back to the default of 8 and abort on a missing user).
    expect(at('Environment=FORGE_EXEC_SLOTS=$FORGE_EXEC_SLOTS')).toBeLessThan(at('ExecStart=/usr/local/libexec/forge-egress.sh apply'));
    expect(setup).toContain('forge-exec-egress.service <<EGRESS\n'); // unquoted heredoc: $FORGE_EXEC_SLOTS is expanded at install time
    expect(setup.split("<<'EGRESST'")[1].split('\nEGRESST\n')[0]).toContain('OnUnitActiveSec=5min');
    // Loaded before the timer starts, synchronously.
    const reload=setup.indexOf('systemctl daemon-reload',at('forge-exec-egress.timer <<'));
    expect(reload).toBeGreaterThan(-1);
    expect(reload).toBeLessThan(at('systemctl enable forge-exec-egress.service'));
    expect(at('systemctl enable forge-exec-egress.service')).toBeLessThan(at('systemctl start forge-exec-egress.service'));
    expect(at('systemctl start forge-exec-egress.service')).toBeLessThan(at('systemctl enable --now forge-exec-egress.timer'));
  });
  it('forge-setup installs and enables it, and documents rollback',()=>{
    const setup=setupSrc();
    expect(setup).toContain('forge-egress.sh');
    expect(setup).toContain('systemctl enable --now forge-exec-egress.timer');
    expect(setup).toContain('nft delete table inet forge_exec_egress');
  });
  // The documented rollback (header comment of BOTH scripts) must undo the ssh.service drop-in FIRST: the drop-in has
  // Requires=forge-exec-egress.service, so stopping the egress service with it still in place can stop sshd.
  const rollbackOf=(src)=>{
    // Header = everything before `set -euo pipefail`; join wrapped comment lines so a command may span a line break.
    const text=src.slice(0,src.indexOf('\nset -euo pipefail')).replace(/\n#[ \t]*/g,' ');
    const at=text.indexOf('Rollback');
    expect(at,'no Rollback in the header').toBeGreaterThan(-1);
    return text.slice(at);
  };
  const ROLLBACK_STEPS=[
    'rm -f /etc/systemd/system/ssh.service.d/forge-egress.conf',
    'systemctl daemon-reload',
    'nft delete table inet forge_exec_egress',
    'systemctl disable --now forge-exec-egress.timer forge-exec-egress.service',
  ];
  for(const [name,read] of [['forge-setup.sh',setupSrc],['forge-egress.sh',()=>readFileSync(script,'utf8')]]){
    it(`${name} documents a rollback that removes the ssh drop-in and reloads BEFORE stopping the egress service`,()=>{
      const rb=rollbackOf(read());
      const idx=ROLLBACK_STEPS.map(s=>{const i=rb.indexOf(s);expect(i,`${name} rollback is missing: ${s}`).toBeGreaterThan(-1);return i;});
      expect(idx).toEqual([...idx].sort((a,b)=>a-b));
    });
  }
});

describe('forge-egress address validation (only well-formed addresses reach nft)',()=>{
  const V4_JUNK='999.1.1.1 1.2.3 256.0.0.1 01.2.3.4 1.2.3.4.5 1.2.3.-4 dead';
  const V6_JUNK=': ::::g :::: dead 1:2 :1 1: ::: 1::2::3 12345::1 1:2:3:4:5:6:7:8:9 1:2:3:4:5:6:7::8:9 ::ffff:999.1.1.1 fe80::1%eth0 ::g';
  it('v4: every octet must be 0-255; malformed values never appear in the ruleset',()=>{
    const r=render({FORGE_EGRESS_UIDS:'990',FORGE_EGRESS_REGISTRY_V4:`${V4_JUNK} 8.8.8.8 255.255.255.255 0.0.0.0`,FORGE_EGRESS_REGISTRY_V6:''});
    expect(r.status).toBe(0);
    expect(elements(r.stdout,'registry4')).toEqual(['0.0.0.0','255.255.255.255','8.8.8.8']);
    for(const bad of V4_JUNK.split(' ')) expect(r.stdout.split(/[\s,{}]+/)).not.toContain(bad);
  });
  it('v6: needs at least two colons and well-formed groups; junk like ":" or "dead" never appears',()=>{
    const good='2606:4700::6810:2323 ::1 1:2:3:4:5:6:7:8 ::ffff:1.2.3.4 1:2:3:4:5:6:7::';
    const r=render({FORGE_EGRESS_UIDS:'990',FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:`${V6_JUNK} ${good}`});
    expect(r.status).toBe(0);
    expect(elements(r.stdout,'registry6')).toEqual(good.split(' ').sort());
    const tokens=r.stdout.split(/[\s,{}]+/);
    for(const bad of V6_JUNK.split(' ')) expect(tokens,`junk reached ruleset: ${bad}`).not.toContain(bad);
  });
  it('the same validation applies to retained history read back from disk',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    const state=join(dir,'state');mkdirSync(state);
    writeFileSync(join(state,'registry4'),'999.1.1.1 1.2.3 7.7.7.7\n');
    writeFileSync(join(state,'registry6'),': ::::g 2606:4700::1\n');
    const r=apply(dir,{FORGE_EGRESS_UIDS:'990',FORGE_EGRESS_STATE_DIR:state,FORGE_EGRESS_REGISTRY_V4:'',FORGE_EGRESS_REGISTRY_V6:''});
    expect(r.status).toBe(0);
    const got=captured(dir);
    expect(elements(got,'registry4')).toEqual(['7.7.7.7']);
    expect(elements(got,'registry6')).toEqual(['2606:4700::1']);
  }));
});

describe('forge-egress snapshot-write failure only narrows the next allowlist (fail closed)',()=>{
  const REAL_MV=spawnSync('sh',['-c','command -v mv'],{encoding:'utf8'}).stdout.trim();
  const slot={FORGE_EGRESS_UIDS:'990'};
  const seed=(state)=>{mkdirSync(state,{recursive:true});writeFileSync(join(state,'registry4'),'9.9.9.9\n');writeFileSync(join(state,'registry6'),'2606:4700::9\n');};
  const runApply=(dir,state,v4,v6)=>apply(dir,{...slot,FORGE_EGRESS_STATE_DIR:state,FORGE_EGRESS_REGISTRY_V4:v4,FORGE_EGRESS_REGISTRY_V6:v6});
  it('a failed write removes the old state file, so the next allowlist holds only current lookup addresses',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    fake(dir,'mv','exit 1'); // the atomic rename fails (disk full / read-only): the old file would otherwise stay
    const state=join(dir,'state');seed(state);
    const r=runApply(dir,state,'1.1.1.1','2606:4700::1');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('could not record the registry4 snapshot');
    expect(existsSync(join(state,'registry4'))).toBe(false);
    expect(existsSync(join(state,'registry6'))).toBe(false);
    rmSync(join(dir,'mv'));
    runApply(dir,state,'2.2.2.2','2606:4700::2');
    const got=captured(dir);
    expect(elements(got,'registry4')).toEqual(['2.2.2.2']);
    expect(elements(got,'registry6')).toEqual(['2606:4700::2']);
  }));
  it('the v4 and v6 records are independent: a v4 failure still records v6 (and clears only the v4 history)',()=>sandbox(dir=>{
    fake(dir,'nft',NFT_CAPTURE);
    fake(dir,'mv',`case "$*" in *registry4) exit 1;; esac\nexec "${REAL_MV}" "$@"`);
    const state=join(dir,'state');seed(state);
    const r=runApply(dir,state,'1.1.1.1','2606:4700::1');
    expect(r.status).toBe(0);
    expect(existsSync(join(state,'registry4'))).toBe(false);
    expect(readFileSync(join(state,'registry6'),'utf8').trim().split('\n').pop()).toBe('2606:4700::1');
  }));
  it('an unwritable state dir never extends history: the next render holds only current lookup addresses',()=>sandbox(dir=>{
    if(typeof process.getuid==='function'&&process.getuid()===0) return; // root bypasses mode bits
    fake(dir,'nft',NFT_CAPTURE);
    const state=join(dir,'state');seed(state);chmodSync(state,0o500);
    try {
      const r=runApply(dir,state,'2.2.2.2','');
      expect(r.status).toBe(0);
      expect(elements(captured(dir),'registry4')).toEqual(['2.2.2.2']);
      expect(readFileSync(join(state,'registry4'),'utf8').trim()).toBe('9.9.9.9'); // could not be removed: ignored, not trusted
    } finally { chmodSync(state,0o700); }
  }));
});
