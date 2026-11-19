/** Regenerate existing capability imports only. This never approves agent launching. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findCapabilityImporters, readAgentLaunchTree } from './lib/agent-launch-structure.mjs';

const root = resolve(import.meta.dirname, '..');
const paths = findCapabilityImporters(readAgentLaunchTree(root), root);
writeFileSync(resolve(root, 'scripts/lib/agent-launch-capability-baseline.json'), JSON.stringify({
  description: 'Snapshot of EXISTING child_process-class capability importers; NOT approval of agent launching. Baseline files remain subject to agent-CLI launch detection.',
  paths,
}, null, 2) + '\n');
console.log(`Recorded ${paths.length} existing capability importers. Review the diff; agent launchers require separate approval.`);
