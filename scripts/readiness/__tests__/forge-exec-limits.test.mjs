// @vitest-environment node
import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DEFAULT_LIMITS,parseLimits,slotLimits,slotCpus,renderParentSlice,renderSlotSlice,setPropertyArgv,scopeLauncherArgv,readLimits} from '../forge-exec-limits.mjs';

describe('Forge slice limits',()=>{
  it.each(['garbage','null','[]','42','{}'])('falls back without throwing for %s',text=>{
    const result=parseLimits(text);
    expect(result.limits).toEqual(DEFAULT_LIMITS);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it('preserves valid partial fields and isolates per-slot overrides',()=>{
    const {limits,warnings}=parseLimits(JSON.stringify({parent:{cpuQuota:'1600%'},slot:{ioWeight:77},slots:{3:{cpuQuota:'125%',tasksMax:'infinity'},4:{cpuQuota:12},bad:{ioWeight:1}}}));
    expect(limits.parent).toEqual({cpuQuota:'1600%',memoryMax:'56G'});
    expect(slotLimits(limits,3)).toEqual({cpuQuota:'125%',memoryMax:'12G',tasksMax:'infinity',ioWeight:77});
    expect(slotCpus(limits,3)).toBe(2);
    expect(slotCpus(limits,4)).toBe(8);
    expect(warnings).toContain('slots.4.cpuQuota: using default');
    expect(warnings).toContain('Invalid slot override: bad');
  });
  it.each([
    {cpuQuota:'0%',memoryMax:'0G',tasksMax:0,ioWeight:0},
    {cpuQuota:800,memoryMax:12,tasksMax:4194305,ioWeight:10001},
    {cpuQuota:'1%;x',memoryMax:'1G\nX=y',tasksMax:1.5,ioWeight:'100'},
    {cpuQuota:false,memoryMax:null,tasksMax:[],ioWeight:{}},
  ])('rejects invalid types and bounds per field: %j',slot=>{
    const {limits,warnings}=parseLimits(JSON.stringify({slot}));
    expect(limits.slot).toEqual(DEFAULT_LIMITS.slot);
    for(const key of Object.keys(slot)) expect(warnings).toContain('slot.'+key+': using default');
  });
  it('accepts boundary values, memory units and infinity',()=>{
    for(const memoryMax of ['1','1K','1M','1G','1T','infinity']) {
      const {limits}=parseLimits(JSON.stringify({slot:{cpuQuota:'1%',memoryMax,tasksMax:4194304,ioWeight:10000}}));
      expect(limits.slot).toEqual({cpuQuota:'1%',memoryMax,tasksMax:4194304,ioWeight:10000});
      expect(slotCpus(limits,1)).toBe(1);
    }
  });
  it('renders exact parent and nested-slot unit directives',()=>{
    expect(renderParentSlice(DEFAULT_LIMITS)).toBe('[Unit]\nDescription=Forge exec aggregate ceiling\n\n[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nIOAccounting=yes\nTasksAccounting=yes\nCPUQuota=2800%\nMemoryMax=56G\n');
    expect(renderSlotSlice(DEFAULT_LIMITS,3)).toBe('[Unit]\nDescription=Forge exec slot 3\n\n[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nIOAccounting=yes\nTasksAccounting=yes\nCPUQuota=800%\nMemoryMax=12G\nMemorySwapMax=0\nTasksMax=2048\nIOWeight=100\n');
    expect(setPropertyArgv(DEFAULT_LIMITS,[3])).toEqual([
      ['set-property','forge-exec.slice','CPUQuota=2800%','MemoryMax=56G'],
      ['set-property','forge-exec-3.slice','CPUQuota=800%','MemoryMax=12G','MemorySwapMax=0','TasksMax=2048','IOWeight=100'],
    ]);
  });
  it('launches a root supervisor with exact scope arguments, optionally through sudo',()=>{
    const args={slot:3,unit:'forge-exec-run-'+'a'.repeat(16),source:'python source',json:'{}'};
    const expected=['/usr/bin/systemd-run','--scope','--quiet','--collect','--slice=forge-exec-3.slice','--unit='+args.unit,'--','/usr/bin/python3','-I','-c','python source','{}'];
    expect(scopeLauncherArgv({...args,sudo:false})).toEqual(expected);
    expect(scopeLauncherArgv(args)).toEqual(['/usr/bin/sudo','-n',...expected]);
  });
  it.each([0,-1,1.5,'1',Infinity])('rejects unsafe slot %s',slot=>{
    expect(()=>scopeLauncherArgv({slot,unit:'forge-exec-run-'+'a'.repeat(16),source:'',json:''})).toThrow('Invalid slot');
  });
  it.each(['forge-exec-run-abc','forge-exec-run-'+'A'.repeat(16),'x;touch x'])('rejects unsafe unit %s',unit=>{
    expect(()=>scopeLauncherArgv({slot:1,unit,source:'',json:''})).toThrow('Invalid scope unit');
  });
  it('uses explicit test paths, falling back for missing, oversized and linked config',async()=>{
    const root=await mkdtemp(join(process.env.TMPDIR,'forge-limits-'));
    try {
      const path=join(root,'limits.json');
      expect((await readLimits({testConfigPath:path})).limits).toEqual(DEFAULT_LIMITS);
      await writeFile(path,'x'.repeat(65537));
      expect((await readLimits({testConfigPath:path})).warnings[0]).toContain('oversized');
      await writeFile(path,JSON.stringify({...DEFAULT_LIMITS,slots:{3:{cpuQuota:'1600%'}}}));
      expect(slotCpus((await readLimits({testConfigPath:path})).limits,3)).toBe(16);
      await symlink(path,join(root,'link'));
      expect((await readLimits({testConfigPath:join(root,'link')})).limits).toEqual(DEFAULT_LIMITS);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('includes the limits module in the installed bundle allowlist and wrapper list',async()=>{
    const setup=await readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    expect(setup).toMatch(/allowed = \{[^\n]*"forge-exec-limits.mjs"/);
    expect(setup).toMatch(/for filename in \[[^\n]*"forge-exec-limits.mjs"/);
    expect(setup).toContain('/usr/local/libexec/forge-exec-limits.mjs apply');
  });
});
