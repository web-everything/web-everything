// Test process bootstrap only. Production modules do not inspect test environment variables.
import { register } from 'node:module';

register('./stale-tool-check-loader.mjs', import.meta.url);
