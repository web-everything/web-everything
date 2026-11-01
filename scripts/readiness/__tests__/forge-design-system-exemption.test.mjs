// @vitest-environment node
// Ruling R312: tracked, secret-free design-systems/*.tokens.json ship to Forge;
// every other credential-named path keeps the existing exclusion.
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {buildManifest} from '../remote-exec.mjs';
import {classifyManifestPath,isDesignTokenPath,isDataRegistryPath,designTokenSecretFinding} from '../forge-exec-manifest.mjs';
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
beforeEach(async()=>{
  cwd=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-design-token-')));
  await git(['init','-q']);await write('keep.txt','keep');
});
afterEach(async()=>fs.rm(cwd,{recursive:true,force:true}));

describe('design-token exemption (R312)',()=>{
  it('ships a tracked, clean top-level design-systems/*.tokens.json',async()=>{
    await write('design-systems/acme.tokens.json',tokens);await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    expect(names(manifest.entries)).toContain('design-systems/acme.tokens.json');
    expect(names(manifest.excluded)).not.toContain('design-systems/acme.tokens.json');
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
  ])('refuses a tracked tokens file containing a %s',async(_label,content,reason)=>{
    expect(designTokenSecretFinding(Buffer.from(content))).toBe(reason);
    await write('design-systems/foo.tokens.json',content);await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file',message:expect.stringContaining('design-systems/foo.tokens.json')});
  });
  it('refuses an untracked design-systems/*.tokens.json',async()=>{
    await git(['add','.']);await commit();await write('design-systems/new.tokens.json',tokens);
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file'});
  });
  it('refuses a tracked tokens file whose blob differs from origin/main',async()=>{
    await write('design-systems/acme.tokens.json',tokens);await git(['add','.']);await commit();
    await write('design-systems/acme.tokens.json',tokens.replace('4px','8px'));await git(['add','.']);
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file'});
  });
  it('refuses a Claude-bridge alias of the design-systems directory',async()=>{
    await write('design-systems/acme.tokens.json',tokens);await fs.mkdir(join(cwd,'.claude/skills'),{recursive:true});
    await fs.symlink('../../design-systems',join(cwd,'.claude/skills/design-systems'));await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
  });
  it('stays policy-excluded and never reusable outside the credential-source channel',()=>{
    expect(classifyManifestPath(Buffer.from('design-systems/acme.tokens.json'))).toMatchObject({excluded:true,credentialSource:true});
  });
  it('keeps excluding nested design-token files and every other token-named path',async()=>{
    for(const p of ['design-systems/x/y.tokens.json','src/_data/design-tokens.json','tokens.json','design-systems/secret.tokens.json'])await write(p,tokens);
    await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    expect(names(manifest.excluded)).toEqual(expect.arrayContaining(['design-systems/secret.tokens.json','design-systems/x/y.tokens.json','src/_data/design-tokens.json','tokens.json']));
    expect(names(manifest.entries)).not.toEqual(expect.arrayContaining(['design-systems/x/y.tokens.json']));
  });
  it('matches only the exact top-level shape',()=>{
    expect(isDesignTokenPath(Buffer.from('design-systems/we-docs.tokens.json'))).toBe(true);
    for(const p of ['design-systems/x/y.tokens.json','other/acme.tokens.json','design-systems/Acme.tokens.json','design-systems/.a.tokens.json','design-systems/acme.tokens.json.bak','design-systems/oauth.tokens.json'])
      expect([p,isDesignTokenPath(Buffer.from(p)),classifyManifestPath(Buffer.from(p)).excluded]).toEqual([p,false,true]);
  });
});

describe('data-registry exemption (R316)',()=>{
  const shipped=['src/_data/protocols/credential-management.json','src/_data/protocols/design-tokens.json',
    'src/_data/intents/credential-enrollment.json','src/_data/semantics/token.json','src/_data/researchTopics/design-token-theming-system.json'];
  const data=JSON.stringify({id:'x',name:'Credential Management',summary:'How tokens and credentials are described in the registry.'});
  it('ships tracked, clean credential-named JSON directly inside the four registries',async()=>{
    for(const p of shipped)await write(p,data);await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    expect(names(manifest.entries)).toEqual(expect.arrayContaining(shipped));
    expect(names(manifest.excluded)).not.toEqual(expect.arrayContaining([shipped[0]]));
    for(const p of shipped)expect(classifyManifestPath(Buffer.from(p))).toMatchObject({excluded:true,credentialSource:true});
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
  ])('refuses a registry file containing a %s',async(_label,content,reason)=>{
    expect(designTokenSecretFinding(Buffer.from(content))).toBe(reason);
    await write('src/_data/protocols/credential-management.json',content);await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file',message:expect.stringContaining('src/_data/protocols/credential-management.json')});
  });
  it('leaves the taint scoped to the secret field',()=>{
    expect(designTokenSecretFinding(Buffer.from('{"token":["x"],"summary":"q8Zr2LmX9vT4pW7kJ1nB5cY3"}'))).toBe(null);
  });
  it('refuses an untracked registry file',async()=>{
    await git(['add','.']);await commit();await write('src/_data/intents/credential-enrollment.json',data);
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file'});
  });
  it('refuses a tracked registry file whose blob differs from origin/main',async()=>{
    await write('src/_data/semantics/token.json',data);await git(['add','.']);await commit();
    await write('src/_data/semantics/token.json',data.replace('x','y'));await git(['add','.']);
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'excluded-source-file'});
  });
  it('refuses a symlinked registry file',async()=>{
    await write('elsewhere/real.json',data);await fs.mkdir(join(cwd,'src/_data/semantics'),{recursive:true});
    await fs.symlink('../../../elsewhere/real.json',join(cwd,'src/_data/semantics/token.json'));await git(['add','.']);await commit();
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
  });
  it('keeps excluding nested, non-JSON and out-of-registry token-named files',async()=>{
    const kept=['src/_data/protocols/nested/token.json','src/_data/protocols/token.yaml','src/_data/token.json',
      'src/_data/other/token.json','scripts/token.json','src/_data/protocols/secret.json'];
    for(const p of kept)await write(p,data);await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    expect(names(manifest.excluded)).toEqual(expect.arrayContaining(kept));
    for(const p of kept)expect(names(manifest.entries)).not.toContain(p);
  });
  it('leaves ordinary registry JSON on its unchanged path, untracked included',async()=>{
    await git(['add','.']);await commit();await write('src/_data/researchTopics/new.json',data);
    const manifest=await buildManifest({cwd,exec});
    expect(manifest.entries.find(e=>names([e])[0]==='src/_data/researchTopics/new.json')).toMatchObject({tracked:false});
    expect(isDataRegistryPath(Buffer.from('src/_data/researchTopics/new.json'))).toBe(false);
  });
  it('matches only the exact one-level shape',()=>{
    for(const p of shipped)expect(isDataRegistryPath(Buffer.from(p))).toBe(true);
    for(const p of ['src/_data/protocols/a/token.json','src/_data/protocols/token.yaml','src/_data/protocols/token.json.bak',
      'src/_data/Protocols/token.json','src/_data/researchtopics/token.json','src/_data/protocols/Token.json','src/_data/protocols/.token.json',
      'src/_data/protocols/secretoken.json','src/_data/protocols/oauth-token.json','src/_data/protocols/api-key.json','src/_data/protocols/id_token.json',
      'src/_data/protocols/token.key.json','lib/_data/protocols/token.json','x/src/_data/protocols/token.json'])
      expect([p,isDataRegistryPath(Buffer.from(p)),classifyManifestPath(Buffer.from(p)).credentialSource]).toEqual([p,false,false]);
  });
});
