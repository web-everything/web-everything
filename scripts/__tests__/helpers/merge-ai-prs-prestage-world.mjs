import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prestagePorts } from '../fixtures/merge-ai-prs-fake-ports.mjs';
import { runInProcess } from '../fixtures/merge-ai-prs-cli-harness.mjs';
import { createPrestageWorld } from '../fixtures/merge-ai-prs-prestage-world.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs');
const sha = 'a'.repeat(40);
const prestageWorld = createPrestageWorld((argv, options) => runInProcess(argv, { ...options, ports: prestagePorts }));
const world = (fn, options) => prestageWorld(fn, { slug: 'web-everything/web-everything', ...options });

export { script, sha, world };
