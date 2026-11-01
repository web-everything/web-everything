// @vitest-environment node
// Ruling R321: a credential-NAMED file ships to Forge only if tracked, identical to
// origin/main and clean of secret content. The established memory bridge may
// project a verified regular source; other credential-named aliases are refused.
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildManifest} from '../remote-exec.mjs';
import {classifyManifestPath,designTokenSecretFinding,credentialContentFinding,isTestFile,manifestEntry} from '../forge-exec-manifest.mjs';
let cwd;
const exec=async ({file,args,cwd,input})=>{
  const result=spawnSync(file,args,{cwd,input,maxBuffer:4*1024*1024});
  if(result.error)throw result.error;
  return {code:result.status,stdout:result.stdout};
};
const git=async args=>{const r=await exec({file:'git',args,cwd});if(r.code!==0)throw new Error('Fixture git failed');return r.stdout;};
// The credential-source channel requires the index blob to equal public origin/main.
const commit=async()=>{await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);await git(['update-ref','refs/remotes/origin/main','HEAD']);};
const write=async(name,data)=>{await fs.mkdir(join(cwd,name,'..'),{recursive:true});await fs.writeFile(join(cwd,name),data);};
const tokens=JSON.stringify({color:{primary:{$value:'#3366ff',$type:'color'}},tokens:{space:{$value:'4px'}}});
const names=list=>list.map(p=>Buffer.from(p.path??p).toString());
const expectExcluded=async path=>{
  const manifest=await buildManifest({cwd,exec});
  expect(names(manifest.excluded)).toContain(path);
  expect(names(manifest.entries)).not.toContain(path);
  expect(names(manifest.entries)).toContain('keep.txt');
};
beforeEach(async()=>{
  cwd=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-design-token-')));
  await git(['init','-q']);await write('keep.txt','keep');
});
afterEach(async()=>fs.rm(cwd,{recursive:true,force:true}));


const njk='---\ntitle: Token handling\n---\n<p>How API tokens and credentials are described.</p>\n';
const shipped=['design-systems/acme.tokens.json','src/_data/protocols/credential-management.json',
  'src/_data/semantics/token.json','src/_data/anything/deep/oauth-token.json','src/_includes/research-descriptions/design-token-theming.njk',
  'docs/password-policy.md'];
const content=p=>p.endsWith('.njk')||p.endsWith('.md')?njk:tokens;
describe('credential-name rule (R321)',()=>{
  it('buildManifest projects the actual tracked repo memory bridge with public evidence pinned to HEAD',async()=>{
    const repo=fileURLToPath(new URL('../../../',import.meta.url));
    // Exercise the real bridge corpus, rather than a hand-picked flat inventory.
    // Only this corpus is copied: the full repo intentionally contains excluded
    // test fixtures and optional sibling dependencies unrelated to projection.
    const inventory=await exec({file:'git',args:['ls-files','-z','--','.claude/agent-memory','agent-memory-src/'],cwd:repo});
    expect(inventory.code).toBe(0);
    const paths=inventory.stdout.toString().split('\0').filter(Boolean);
    expect(paths).toContain('.claude/agent-memory');
    expect(paths).toContain('agent-memory-src/8-project_theme_tokens_js_first.md');
    expect(paths).toContain('agent-memory-src/never-touch-secrets-even-filenames.md');
    for(const path of paths){
      const source=join(repo,path);
      if((await fs.lstat(source)).isSymbolicLink()){
        await fs.mkdir(join(cwd,path,'..'),{recursive:true});
        await fs.symlink(await fs.readlink(source),join(cwd,path));
      }else await write(path,await fs.readFile(source));
    }
    await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    for(const path of paths.filter(p=>p.startsWith('agent-memory-src/'))){
      const source=manifest.entries.find(entry=>entry.path.toString()===path);
      const alias=manifest.entries.find(entry=>entry.path.toString()==='.claude/agent-memory/'+path.slice('agent-memory-src/'.length));
      expect(source,path).toBeDefined();expect(alias,path).toMatchObject({sha256:source.sha256,tracked:false,sourcePath:Buffer.from(path)});
    }
  },30000);
  it('ships every real tracked credential-named file (R352) and retains the missing-test fallback for a refused test',async()=>{
    const repo=fileURLToPath(new URL('../../../',import.meta.url));
    const inventory=await exec({file:'git',args:['ls-files','-z'],cwd:repo});
    expect(inventory.code).toBe(0);
    const flagged=inventory.stdout.toString().split('\0').filter(p=>p&&classifyManifestPath(Buffer.from(p)).credentialSource);
    expect(flagged).toContain('scripts/lib/secret-scrub.mjs');
    // R352: no real tracked file spells out a secret any more, so none is refused.
    const refused=[];
    for(const p of flagged){
      const bytes=await fs.readFile(join(repo,p));
      if(credentialContentFinding(Buffer.from(p),bytes))refused.push(p);
    }
    expect(refused).toEqual([]);
    // The fallback itself stays covered by a synthetic refused test file, header assembled at run time.
    const refusedTest='scripts/__tests__/token-sample.test.mjs';
    await write(refusedTest,`// ${'-----'+'BEGIN'} sample\n`);
    await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'unshipped-test-file'});
  });
  it('keeps every real tracked design-system tokens file scan-clean and shippable',async()=>{
    const repo=fileURLToPath(new URL('../../../',import.meta.url));
    const inventory=await exec({file:'git',args:['ls-files','-z','--','design-systems/*.tokens.json'],cwd:repo});
    expect(inventory.code).toBe(0);
    const paths=inventory.stdout.toString().split('\0').filter(Boolean);
    expect(paths.length).toBeGreaterThanOrEqual(8);
    for(const p of paths){
      const bytes=await fs.readFile(join(repo,p));
      expect(designTokenSecretFinding(bytes),p).toBe(null);
      await write(p,bytes);
    }
    await git(['add','.']);await commit();
    expect(names((await buildManifest({cwd,exec})).entries)).toEqual(expect.arrayContaining(paths));
  });
  it('ships a tracked file identical to origin/main with clean content, in any folder',async()=>{
    for(const p of shipped)await write(p,content(p));await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    expect(names(manifest.entries)).toEqual(expect.arrayContaining(shipped));
    for(const p of shipped){
      expect(names(manifest.excluded)).not.toContain(p);
      expect(classifyManifestPath(Buffer.from(p))).toMatchObject({excluded:true,credentialSource:true});
    }
  });
  it('ships a tracked .njk research description whose name has a token word',async()=>{
    const p='src/_includes/research-descriptions/token-economy.njk';
    await write(p,njk);await git(['add','.']);await commit();
    expect(names((await buildManifest({cwd,exec})).entries)).toContain(p);
  });
  it('never ships a name-flagged file that is untracked (source files refuse, others stay excluded)',async()=>{
    await git(['add','.']);await commit();
    const p='src/_includes/research-descriptions/token-new.njk';await write(p,njk);
    const manifest=await buildManifest({cwd,exec});
    expect(names(manifest.excluded)).toContain(p);expect(names(manifest.entries)).not.toContain(p);
    await write('lib/token-new.mjs','export {};');
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file'});
  });
  it('never ships a tracked file modified versus origin/main',async()=>{
    await write('a/token-page.njk',njk);await write('b/token-view.json',tokens);await git(['add','.']);await commit();
    await write('a/token-page.njk',njk+'changed');await write('b/token-view.json',tokens.replace('4px','8px'));await git(['add','.']);
    const manifest=await buildManifest({cwd,exec});
    for(const p of ['a/token-page.njk','b/token-view.json']){expect(names(manifest.excluded)).toContain(p);expect(names(manifest.entries)).not.toContain(p);}
  });
  it('refuses a tracked-but-unstaged edit versus origin/main',async()=>{
    await write('a/token-page.njk',njk);await git(['add','.']);await commit();
    await write('a/token-page.njk',njk+'changed');
    // The staged blob equals main but the worktree bytes do not: refused outright.
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file'});
  });
  it('refuses a symlinked name-flagged file',async()=>{
    await write('elsewhere/real.json',tokens);await fs.mkdir(join(cwd,'src/_data/semantics'),{recursive:true});
    await fs.symlink('../../../elsewhere/real.json',join(cwd,'src/_data/semantics/token.json'));await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
  });
  it('refuses a name-flagged file reached through a symlinked directory',async()=>{
    await write('design-systems/acme.tokens.json',tokens);await fs.mkdir(join(cwd,'.claude/skills'),{recursive:true});
    await fs.symlink('../../design-systems',join(cwd,'.claude/skills/design-systems'));await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
  });
  it('excludes fake secrets even when tracked and identical to origin/main',async()=>{
    await write('a/token-page.njk','x ghp_abcdefghijklmnopqrstuvwxyz0123 y');await git(['add','.']);await commit();
    await expectExcluded('a/token-page.njk');
  });
  it('keeps names unsafe for other reasons excluded even when tracked and identical',async()=>{
    const kept=['.env.token','keys/server_rsa','certs/token.pem','.hidden/token.json'];
    for(const p of kept)await write(p,'x');await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    expect(names(manifest.excluded)).toEqual(expect.arrayContaining(kept));
    for(const p of kept)expect(names(manifest.entries)).not.toContain(p);
  });
  it('leaves other file types excluded when not tracked-identical, as before',async()=>{
    await git(['add','.']);await commit();await write('notes/token.txt','local');
    expect(names((await buildManifest({cwd,exec})).excluded)).toContain('notes/token.txt');
  });
  it.each(['token.json.','token.json ','token.ｊｓｏｎ','TOKEN.JSON'])('scans %s with the structural JSON scanner',name=>{
    const secret=Buffer.from('{"password":"q8Zr2LmX9vT4pW7kJ1nB5cY3!"}');
    expect(credentialContentFinding(Buffer.from('a/'+name),secret)).toBe('high-entropy-password');
  });
  it('excludes a tracked name-flagged JSON secret under a normalized-extension name',async()=>{
    await write('a/token.json.','{"password":"q8Zr2LmX9vT4pW7kJ1nB5cY3!"}');await git(['add','.']);await commit();
    await expectExcluded('a/token.json.');
  });
  it('projects a verified name-flagged JSON file through the established agent-memory bridge',async()=>{
    await write('agent-memory-src/token.json',tokens);await fs.mkdir(join(cwd,'.claude'),{recursive:true});
    await fs.symlink('../agent-memory-src',join(cwd,'.claude/agent-memory'));await git(['add','.']);await commit();
    expect(names((await buildManifest({cwd,exec})).entries)).toContain('.claude/agent-memory/token.json');
  });
  it.each(['lib/token-scrub.mjs','docs/token-notes.md','src/credential-view.ts'])('excludes a tracked flagged %s containing a fake secret (R323, no type skip)',async p=>{
    await write(p,'const x = "ghp_abcdefghijklmnopqrstuvwxyz0123";\n');await git(['add','.']);await commit();
    await expectExcluded(p);
  });
  it('refuses a flagged source file with a PEM marker too',()=>{
    expect(credentialContentFinding(Buffer.from('a/token.mjs'),Buffer.from('-----BEGIN PRIVATE KEY-----'))).toBe('pem-header');
  });
  it('ships a tracked flagged clean .mjs identical to origin/main',async()=>{
    await write('lib/token-util.mjs','export const ok = 1;\n');await git(['add','.']);await commit();
    expect(names((await buildManifest({cwd,exec})).entries)).toContain('lib/token-util.mjs');
  });
  it('projects clean verified memory but refuses secret-like memory content',async()=>{
    await write('agent-memory-src/token-note.md','clean notes');await fs.mkdir(join(cwd,'.claude'),{recursive:true});
    await fs.symlink('../agent-memory-src',join(cwd,'.claude/agent-memory'));await git(['add','.']);await commit();
    expect(names((await buildManifest({cwd,exec})).entries)).toContain('.claude/agent-memory/token-note.md');
    await write('agent-memory-src/token-note.md','ghp_abcdefghijklmnopqrstuvwxyz0123');await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
  });
  it('refuses a bridge alias whose real source directory is name-flagged (token-src)',async()=>{
    await write('token-src/note.md','clean notes');await fs.mkdir(join(cwd,'.claude'),{recursive:true});
    await fs.symlink('../token-src',join(cwd,'.claude/agent-memory'));await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
  });
  it('scans non-JSON content with the raw secret patterns',()=>{
    expect(credentialContentFinding(Buffer.from('a/token.njk'),Buffer.from('AKIAABCDEFGHIJKLMNOP'))).toBe('aws-access-key');
    expect(credentialContentFinding(Buffer.from('a/token.njk'),Buffer.from('plain text'))).toBe(null);
  });
});

describe('manifestEntry fail-closed leaf guard',()=>{
  it.each([
    ['untracked clean file',tokens,false],
    ['tracked content finding','{"password":"q8Zr2LmX9vT4pW7kJ1nB5cY3!"}',true],
    ['untracked content finding','{"password":"q8Zr2LmX9vT4pW7kJ1nB5cY3!"}',false],
  ])('manifestEntry rejects %s directly',(_label,content,tracked)=>{
    expect(()=>manifestEntry(Buffer.from('a/token.json'),Buffer.from(content),false,tracked))
      .toThrow(expect.objectContaining({code:'excluded-source-file'}));
  });
  it('manifestEntry admits tracked scan-clean content directly',()=>{
    expect(manifestEntry(Buffer.from('a/token.json'),Buffer.from(tokens),false,true)).toMatchObject({tracked:true});
  });
});

describe('content secret scan',()=>{
  it.each([
    ['PEM','-----BEGIN','pem-header'],
    ['standalone private key','PRIVATE KEY','private-key'],
    ['AWS','AKIAABCDEFGHIJKLMNOP','aws-access-key'],
    ...'opsur'.split('').map(kind=>['GitHub '+kind,`gh${kind}_abcdefghijklmnopqrstuvwxyz0123`,'github-token']),
    ['sk','sk-abcdefghijklmnopqrstuvwxyz0123','sk-token'],
    ['Slack bot','xoxb-12345678-abcdefgh','slack-token'],
    ['Slack user','xoxp-12345678-abcdefgh','slack-token'],
  ])('detects %s signatures in raw text and decoded JSON literals',(_label,value,reason)=>{
    expect(credentialContentFinding(Buffer.from('token.txt'),Buffer.from(value))).toBe(reason);
    const escaped=[...value].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
    expect(designTokenSecretFinding(Buffer.from(`{"value":"${escaped}","value":"safe"}`))).toBe(reason);
  });
  it.each(['credentials.yaml','credentials.ini','credentials.txt','credentials'])('detects keyed random passwords in %s',path=>{
    for(const line of ['password: ','password = ','  - "password": ',"\r\n'password': "]){
      expect(credentialContentFinding(Buffer.from(path),Buffer.from(line+'q8Zr2LmX9vT4pW7kJ1nB5cY3'))).toBe('high-entropy-password');
    }
    expect(credentialContentFinding(Buffer.from(path),Buffer.from('password: example'))).toBe(null);
  });
  it.each([
    ['UTF-16LE',Buffer.from('password: q8Zr2LmX9vT4pW7kJ1nB5cY3','utf16le')],
    ['invalid UTF-8',Buffer.from([0xff,0xfe,0x61])],
  ])('refuses unsupported %s text encoding',(_label,bytes)=>{
    expect(credentialContentFinding(Buffer.from('credentials.txt'),bytes)).toBe('unsupported-text-encoding');
  });
  it('does not mistake task- or disk-prefixed prose for an sk token',()=>{
    for(const value of ['task-abcdefghijklmnopqrstuvwxyz','disk-abcdefghijklmnopqrstuvwxyz'])expect(credentialContentFinding(Buffer.from('token.md'),Buffer.from(value))).toBe(null);
  });
  it.each([
    ['private key','{"a":"-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----"}','pem-header'],
    ['AWS key','{"a":"AKIAABCDEFGHIJKLMNOP"}','aws-access-key'],
    ['GitHub token','{"a":"ghp_abcdefghijklmnopqrstuvwxyz0123"}','github-token'],
    ['high-entropy apiKey field','{"apiKey":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}','high-entropy-apiKey'],
    ['punctuated password','{"password":"q8Zr2LmX9vT4pW7kJ1nB5cY3!"}','high-entropy-password'],
    ['JSON-escaped GitHub token','{"a":"\\u0067hp_abcdefghijklmnopqrstuvwxyz0123"}','github-token'],
    ['spaced password','{"password":"q8Zr2LmX9vT4pW7kJ1nB5cY3 !"}','high-entropy-password'],
    ['root JSON string','"\\u0067hp_abcdefghijklmnopqrstuvwxyz0123"','non-object-json'],
    ['duplicate-key escaped token','{"a":"\\u0067hp_abcdefghijklmnopqrstuvwxyz0123","a":"safe"}','github-token'],
    ['duplicate-key password','{"password":"q8Zr2LmX9vT4pW7kJ1nB5cY3 !","password":"safe"}','high-entropy-password'],
    ['astral-character password',JSON.stringify({password:String.fromCodePoint(...Array.from({length:24},(_,i)=>0x1F600+i))}),'high-entropy-password'],
    ['letter-prefixed GitHub token','{"value":"prefixghp_abcdefghijklmnopqrstuvwxyz0123456789"}','github-token'],
    ['underscore-prefixed GitHub token','{"a":"_ghp_abcdefghijklmnopqrstuvwxyz0123"}','github-token'],
  ])('excludes a tracked tokens file containing a %s',async(_label,content,reason)=>{
    expect(designTokenSecretFinding(Buffer.from(content))).toBe(reason);
    await write('design-systems/foo.tokens.json',content);await git(['add','.']);await commit();
    await expectExcluded('design-systems/foo.tokens.json');
  });
  it.each([
    ['GitHub token','{"a":"ghp_abcdefghijklmnopqrstuvwxyz0123"}','github-token'],
    ['high-entropy token field','{"token":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}','high-entropy-token'],
    ['private key','{"a":"-----BEGIN RSA PRIVATE KEY-----"}','pem-header'],
    ['secret in an array under a token field','{"token":["public","q8Zr2LmX9vT4pW7kJ1nB5cY3"]}','high-entropy-nested'],
    ['secret in an object under a token field','{"token":{"value":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}}','high-entropy-nested'],
    ['deeply nested secret under a token field','{"token":{"a":{"b":["q8Zr2LmX9vT4pW7kJ1nB5cY3"]}}}','high-entropy-nested'],
    ['high-entropy credential field','{"credential":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}','high-entropy-credential'],
    ['high-entropy creds field','{"creds":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}','high-entropy-creds'],
    ['high-entropy oauth field','{"oauth":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}','high-entropy-oauth'],
    ['secret used as a key under a token field','{"token":{"q8Zr2LmX9vT4pW7kJ1nB5cY3":"public"}}','high-entropy-nested-key'],
  ])('excludes a registry file containing a %s',async(_label,content,reason)=>{
    expect(designTokenSecretFinding(Buffer.from(content))).toBe(reason);
    await write('src/_data/protocols/credential-management.json',content);await git(['add','.']);await commit();
    await expectExcluded('src/_data/protocols/credential-management.json');
  });
  it('leaves the taint scoped to the secret field',()=>{
    expect(designTokenSecretFinding(Buffer.from('{"token":["x"],"summary":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}'))).toBe(null);
  });
});
