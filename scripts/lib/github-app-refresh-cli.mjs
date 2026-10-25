#!/usr/bin/env node
/** Bounded by the shim; emit only a safe result, never credentials or dependency diagnostics. */
import { ensureFreshGithubAppEnv } from './github-app-auth-env.mjs';

const role = process.argv.slice(2).find((arg) => arg.startsWith('--role='))?.slice(7);
let result;
try {
  result = await ensureFreshGithubAppEnv({
    perOwner: true, daemon: true, role, env: { ...process.env, WE_POLICY_CASCADE_LOG: '0' },
    installShim: async () => ({ ok: true }), log: { error() {} },
  });
} catch {
  result = { applied: false, reason: 'refresh-failed' };
}
// All fields are selected from known outcomes; never serialize env or an exception.
const safe = (value) => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
process.stdout.write(`applied=${Boolean(result.applied)} reason=${safe(result.reason)} role=${safe(result.role)}\n`);
process.exitCode = result.applied ? 0 : 1;
