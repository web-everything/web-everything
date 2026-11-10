// @vitest-environment node
// R352: the files that used to spell out sample secrets must now pass the Forge
// content scan (R321/R323) honestly, so full-tree standards runs are not forced
// back to the Mac with `excluded-source-file`. No new exception, no weakened scan.
import {describe,expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {credentialContentFinding,manifestEntry} from '../forge-exec-manifest.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','..','..');
const cards=readdirSync(join(root,'backlog')).filter(f=>/^(?:2806|3866|3912|4382)-/.test(f)).map(f=>`backlog/${f}`);
const files=[
  'scripts/lib/secret-scrub.mjs','scripts/lib/github-app-token.mjs',
  'scripts/conveyor/soak/breaks/smoke-expired-gh-token.mjs','scripts/rust-scan/src/secret_scrub.rs',
  'scripts/__tests__/secret-scrub.test.mjs','scripts/__tests__/rust-scan-secret-scrub-parity.test.mjs',
  'scripts/__tests__/publish-secret-gate.test.mjs',
  // Found by the same scan once the listed files were clean: heuristic hits on field names.
  'scripts/conveyor/credential-inventory.mjs','scripts/conveyor/health-smells/__tests__/credential-inventory-stale.test.mjs',
  'scripts/lib/__tests__/github-app-token.test.mjs',...cards,
];

describe('R352 formerly excluded files pass the Forge content scan',()=>{
  it('finds all four cards',()=>expect(cards).toHaveLength(4));
  it.each(files)('%s has 0 refusals',path=>{
    const content=readFileSync(join(root,path));
    expect(credentialContentFinding(Buffer.from(path),content)).toBeNull();
    expect(()=>manifestEntry(Buffer.from(path),content,false,true)).not.toThrow();
  });
  it('the shared sample-strings fixture module passes the scan too',()=>{
    const path='scripts/__tests__/fixtures/sample-strings.mjs';
    expect(credentialContentFinding(Buffer.from(path),readFileSync(join(root,path)))).toBeNull();
  });
});
