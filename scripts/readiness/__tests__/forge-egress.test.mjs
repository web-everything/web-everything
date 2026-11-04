// @vitest-environment node
// R497 step 3: the generated nftables rule set drops slot-user egress except loopback and the npm registry.
import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync,mkdirSync} from 'node:fs';
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
    expect(setup).toContain('Before=ssh.service sshd.service');
    expect(setup).toContain('OnBootSec=1min');
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
});
