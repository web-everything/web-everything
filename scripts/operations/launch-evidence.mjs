/** Durable background-launch evidence, like wrapper specs/envelopes, bound to the CLI-assigned handle.
 * Historical or unreadable records require operator recovery; a current PR read cannot recreate a pin.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCompletionsDir } from './completion-store.mjs';
import { assertLaunchDescriptor, refuseFixerLaunch } from '../conveyor/conflict-rebase-launch-gate.mjs';

function evidencePath(sessionId, dir) {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId ?? '')) refuseFixerLaunch('invalid saved launch session id');
  return join(dir, `${sessionId}.json`);
}
const evidenceDir = () => join(resolveCompletionsDir(), '.launch-evidence');

export function saveLaunchEvidence(sessionId, descriptor, { dir = evidenceDir() } = {}) {
  assertLaunchDescriptor(descriptor);
  const file = evidencePath(sessionId, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { mode, launchGuard, launchContext } = descriptor;
  writeFileSync(temporary, JSON.stringify({ v: 1, sessionId, mode, launchGuard, launchContext }), { mode: 0o600 });
  renameSync(temporary, file);
}

export function readLaunchEvidence(sessionId, { dir = evidenceDir() } = {}) {
  let record;
  try { record = JSON.parse(readFileSync(evidencePath(sessionId, dir), 'utf8')); }
  catch { refuseFixerLaunch('missing or unreadable saved launch evidence'); }
  if (record?.v !== 1 || record?.sessionId !== sessionId) refuseFixerLaunch('saved launch evidence is not bound to this session');
  assertLaunchDescriptor(record);
  return record;
}

/** Blocking delivery turns retain the same descriptor across both provider-native resume paths. */
export function workerLaunchEvidence({ sessionId, resumeSessionId, mode, launchGuard }, {
  readSavedLaunch = readLaunchEvidence, saveEvidence = saveLaunchEvidence,
} = {}) {
  const descriptor = resumeSessionId ? readSavedLaunch(resumeSessionId) : { mode, launchGuard };
  assertLaunchDescriptor(descriptor);
  if (!resumeSessionId && sessionId) saveEvidence(sessionId, descriptor);
  return { mode: descriptor.mode, launchGuard: descriptor.launchGuard };
}
