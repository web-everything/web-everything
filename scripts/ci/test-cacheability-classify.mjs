import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
// Static test-cacheability classifier (R578). Usage: node scripts/ci/test-cacheability-classify.mjs [--out=<json>]
// Rules are plain regex tables at the top of this file (R528: promote to a settings file when adopted).
const root=execFileSync('git',['rev-parse','--show-toplevel']).toString().trim();
const files=execFileSync('git',['ls-files','*.test.mjs','*.test.ts','*.test.js','*.soak.test.mjs'],{cwd:root,maxBuffer:1e8}).toString().split('\n').filter(Boolean);
const tm=JSON.parse(fs.readFileSync(root+'/scripts/ci/test-timings.json'));
const time={...tm.unit,...tm.soak};
const R={
 process:[/\bchild_process\b/,/\b(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/,/process\.execPath/],
 git:[/\bsimple-git\b/,/['"`]git['"`]\s*,\s*\[/,/\bgit\s+(init|clone|commit|worktree|fetch|checkout|rev-parse|log|ls-files|config)\b/,/runGit|gitInit|git\(\s*\[/],
 repofs:[/homedir\(\)|process\.env\.HOME|~\/\.claude|\.operations|\/Users\//,/process\.cwd\(\)/,/(__dirname|import\.meta\.(dirname|url))[^\n]*\.\.\//,/ROOT\s*=|REPO_ROOT|repoRoot/],
 clock:[/Date\.now\(\)|new Date\(\s*\)|performance\.now/],
 realwait:[/setTimeout\s*\(|setInterval\s*\(|sleep\(|Atomics\.wait/],
 network:[/\bfetch\s*\(|from ['"](node:)?(http|https|net|dgram|tls)['"]|createServer\s*\(|\.listen\s*\(/],
 env:[/process\.env\.\w+|process\.env\[/],
 random:[/Math\.random|randomUUID|randomBytes|crypto\.getRandomValues/]};
const out=[];
function helperText(f,seen,depth){if(depth>2)return '';let s;try{s=fs.readFileSync(path.join(root,f),'utf8')}catch{return ''}let acc='';
 for(const m of s.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)){let p=path.join(path.dirname(f),m[1]);for(const c of [p,p+'.mjs',p+'.ts',p+'.js']){if(seen.has(c))continue;try{if(fs.statSync(path.join(root,c)).isFile()){seen.add(c);if(/\.test\./.test(c))break;const t=fs.readFileSync(path.join(root,c),'utf8');acc+='\n'+t+helperText(c,seen,depth+1);break}}catch{}}}return acc}
for(const f of files){let s;try{s=fs.readFileSync(path.join(root,f),'utf8')}catch{continue}
 const own=s;s=s+'\n'+('');
 const lines=s.split('\n');const hits={};
 for(const [k,res] of Object.entries(R)){for(let i=0;i<lines.length;i++){const l=lines[i];if(/^\s*(\/\/|\*)/.test(l))continue;if(res.some(r=>r.test(l))){(hits[k]??=[]).push(i+1)}}}
 const fake=/vi\.useFakeTimers|useFakeTimers/.test(s);const stubEnv=/vi\.stubEnv|vi\.stubGlobal\(/.test(s);const tmp=/os\.tmpdir|mkdtemp|tmpdir\(/.test(s);
 const declared=/@uncacheable:/.test(s);
 // downgrade
 if(fake){delete hits.clock;delete hits.realwait}
 if(stubEnv)delete hits.env;
 if(hits.random&&/seed|mulberry|vi\.spyOn\(Math,\s*'random'/.test(s))delete hits.random;
 // repofs only if no tmp-only ; cwd/ROOT reads alone: weak
 const strong=[];
 if(hits.process)strong.push('process');
 if(hits.git&&(hits.process||/execFile|spawn|simple-git/.test(s)))strong.push('git');
 if(hits.network&&/\bfetch\s*\(|createServer|listen\(|node:(http|net)|from 'https?'/.test(s)&&!/vi\.stubGlobal\('fetch'|mockFetch|vi\.fn\(\)[^\n]*fetch/.test(s))strong.push('network');
 if(hits.repofs&&(hits.repofs.some(n=>/homedir|HOME|\.claude|\.operations|\/Users\//.test(lines[n-1]))))strong.push('repofs');
 const soft=[];if(hits.clock)soft.push('clock');if(hits.realwait)soft.push('realwait');if(hits.env)soft.push('env');if(hits.random)soft.push('random');if(tmp)soft.push('tmpfs');
 if(hits.repofs&&!strong.includes('repofs'))soft.push('repo-read');
 if(/\.soak\.test\./.test(f)&&!strong.length)strong.push('soak-daemon-harness');
 let cls=strong.length?'uncacheable':(soft.length?'soft':'cacheable');
 out.push({f,cls,strong,soft,hits,t:time[f]??0,declared});}
const outArg=(process.argv.find(a=>a.startsWith('--out='))||'--out=scripts/ci/test-cacheability-report.json').slice(6);fs.writeFileSync(path.join(root,outArg),JSON.stringify({generated:'static',classes:out.map(({f,cls,strong,soft,t,declared})=>({f,cls,strong,soft,t,declared}))},null,1)+'\n');
const agg={};let T=0;for(const o of out){const a=agg[o.cls]??={n:0,t:0};a.n++;a.t+=o.t;T+=o.t}
console.log(out.length,T.toFixed(0),Object.entries(agg).map(([k,v])=>`${k}: n=${v.n} (${(100*v.n/out.length).toFixed(1)}%) t=${v.t.toFixed(0)}s (${(100*v.t/T).toFixed(1)}%)`).join('\n'));
const miss=out.filter(o=>!(o.f in time)).length;console.log('no timing',miss);
const cnt={};for(const o of out)for(const k of [...o.strong,...o.soft])cnt[k]=(cnt[k]??0)+1;console.log(JSON.stringify(cnt));
const top=out.filter(o=>o.cls==='uncacheable').sort((a,b)=>b.t-a.t).slice(0,30);
for(const o of top)console.log(o.t.toFixed(1),o.f,o.strong.map(k=>k+':'+(o.hits[k]||[]).slice(0,2).join(',')).join(' '));
// by soak/unit
for(const sec of ['unit','soak']){const ks=Object.keys(tm[sec]);const g={};let tt=0;for(const o of out)if(o.f in tm[sec]){const a=g[o.cls]??={n:0,t:0};a.n++;a.t+=o.t;tt+=o.t}console.log(sec,tt.toFixed(0),JSON.stringify(g))}
