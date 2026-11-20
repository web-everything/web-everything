// Inherited by the real CLI worker, so both threads use the same hermetic IO ports.
import { register } from 'node:module';
register('./ci-heal-worker-loader.mjs', import.meta.url);
