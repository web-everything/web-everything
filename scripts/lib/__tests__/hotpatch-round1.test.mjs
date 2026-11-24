import {it, expect, vi} from 'vitest';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {replaceRegistration} from '../../daemon-overlay.mjs';
import {selectSyncTargets, runOverlayMainSync} from '../daemon-rebuild/overlay-main-sync.mjs';
import {revokedAppliedTips} from '../daemon-rebuild/audited-tip.mjs';
import {resolveOverlayConflict} from '../daemon-rebuild/overlay-strategies.mjs';
import {planRebuild} from '../daemon-rebuild/plan.mjs';
const sha = 'a'.repeat(40), ref = `hotpatch/${sha}`;
it('R1: replace refuses hotpatch at entry without registering or dropping anything', async () => {
  expect(await replaceRegistration({root: '/absent', ref, old: 'lane/old', expectedSha: sha, checkOnly: true})).toMatchObject({ok: false, refused: 'hotpatch-replace-forbidden'});
});
it('R2: rebuild skips a mutable tip differing from the hotpatch suffix even on first adoption', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hp-round1-'));
  const git = args => {try {return {status: 0, stdout: execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe']})};} catch(e) {return {status: e.status, stdout: e.stdout};}};
  try {
    git(['init','-q','-b','main']); writeFileSync(join(root,'a'), 'base'); git(['add','.']); git(['-c','user.name=t','-c','user.email=t@t','commit','-qm','base']);
    const base = git(['rev-parse','HEAD']).stdout.trim(); git(['update-ref','refs/remotes/origin/main',base]);
    writeFileSync(join(root,'a'), 'patch'); git(['add','.']); git(['-c','user.name=t','-c','user.email=t@t','commit','-qm','patch']);
    git(['update-ref',`refs/remotes/origin/${ref}`,'HEAD']);
    const result = await planRebuild({git, headSha: base, mainRef: 'origin/main', overlays: [{ref}], auditedTip: () => false});
    expect(result.applied).toEqual([]);
    expect(result.decisions).toContainEqual(expect.objectContaining({ref, action: 'skip', reason: 'hotpatch-ref-sha-mismatch'}));
  } finally {rmSync(root,{recursive:true,force:true});}
});
it('R3: first adoption cannot exempt a hotpatch from revocation', () => {
  expect(revokedAppliedTips({applied:[{ref,sha}], auditedTip:()=>false, auditAdopted:[], carries:()=>true})).toEqual([ref]);
});
it('R4: main-sync excludes hotpatch refs and refuses direct workers', async () => {
  expect(selectSyncTargets({overlays:[{ref},{ref:'lane/a'}]})).toEqual(['lane/a']);
  expect(await runOverlayMainSync({root:'/absent',ref})).toMatchObject({reason:'hotpatch-main-sync-forbidden'});
});
it('R5: hotpatch conflict strategies never inspect even approved edges', () => {
  const git = vi.fn(() => {throw new Error('must not inspect strategies');});
  expect(resolveOverlayConflict({git,cur:sha,ovSha:sha,ref,approvedEdgeSha:sha})).toMatchObject({ok:false, tried:[]});
  expect(git).not.toHaveBeenCalled();
});
