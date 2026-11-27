/** Test-only mutation reference. Each switch introduces exactly one unsafe behavior. */
import * as safe from '../../host-credential-cutover.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
export * from '../../host-credential-cutover.mjs';
export const VARIANTS = Object.freeze(['shell-true', 'inherit-env', 'no-timeout', 'trust-env-operators',
  'drop-root', 'trust-persisted-findings', 'loose-metadata', 'read-gh-config', 'token-read', 'post',
  'paginate-flag', 'trust-any-login', 'treat-error-as-empty', 'trust-short-page', 'follow-cycle',
  'sample-repos', 'skip-detail', 'numeric-actor-only', 'ignore-org-admin', 'ignore-admin-level',
  'mix-runs', 'accept-stale', 'follow-symlink', 'trust-persisted-result', 'skip-counts',
  'skip-second-pass', 'repo-only-rulesets', 'fatal-needs-login', 'page-two-unread',
  'redact-and-pass', 'leak-stderr', 'leak-field', 'complete-with-findings-as-complete']);
const variant = process.env.INVENTORY_UNSAFE;
const complete = out => ({ ...out, result: 'COMPLETE', exitCode: 0, reasons: [], findings: [] });
function rewrite(out, transform) {
  const separator = /\r?\n\r?\n/.exec(out.stdout ?? '');
  if (!separator) return out;
  let body;
  try { body = JSON.parse(out.stdout.slice(separator.index + separator[0].length)); } catch { return out; }
  return { ...out, stdout: out.stdout.slice(0, separator.index + separator[0].length) + JSON.stringify(transform(body)) };
}
function unsafeOptions(options) {
  const run = options.run;
  const result = { ...options, run: async (exe, argv, opts) => {
    let args = argv;
    if (variant === 'post') args = argv.map(a => a === 'GET' ? 'POST' : a);
    if (variant === 'paginate-flag') args = [...argv.slice(0, -1), '--paginate', argv.at(-1)];
    const path = argv.at(-1);
    let out = await run(exe, args, opts);
    if (variant === 'leak-stderr' && out.stderr) options.stderr(out.stderr);
    if (variant === 'leak-field' && out.stdout?.includes('ghp_')) options.stdout(out.stdout);
    if (['trust-env-operators', 'trust-any-login'].includes(variant) && path === '/user') {
      out = rewrite(out, body => ({ ...body, login: 'chalbert' }));
    }
    if (variant === 'treat-error-as-empty' && out.code !== 0) out = { code: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"source_type":"Repository","bypass_actors":[]}' };
    if (variant === 'trust-short-page') out = rewrite(out, body => Array.isArray(body) && body.length === 100 ? { truncated: true } : body);
    if (variant === 'follow-cycle' && out.stdout?.toLowerCase().includes('link:')) {
      // Blindly stop at the first page instead of validating a hostile/cyclic Link.
      out = { ...out, stdout: out.stdout.replace(/^link:.*\r?\n/im, '') };
    }
    if (variant === 'sample-repos' && path.includes('/repos?') && out.stdout?.includes('link:')) {
      out = { ...out, stdout: out.stdout.replace(/^link:.*\r?\n/im, '') };
    }
    if (variant === 'skip-detail' && path.includes('/hidden/rulesets/7')) out = rewrite(out, body => ({ ...body, bypass_actors: [] }));
    if (variant === 'numeric-actor-only') out = rewrite(out, body => body?.bypass_actors
      ? { ...body, bypass_actors: body.bypass_actors.map(a => ({ ...a, actor_id: a.actor_id ?? 1 })) } : body);
    if (variant === 'ignore-org-admin') out = rewrite(out, body => body?.installations ? { ...body,
      installations: body.installations.map(i => ({ ...i, permissions: Object.fromEntries(Object.entries(i.permissions).filter(([k]) => k !== 'organization_administration')) })) } : body);
    if (variant === 'ignore-admin-level') out = rewrite(out, body => body?.installations ? { ...body,
      installations: body.installations.map(i => ({ ...i, permissions: Object.fromEntries(Object.entries(i.permissions).map(([k, v]) => [k, v === 'admin' ? 'read' : v])) })) } : body);
    if (variant === 'skip-counts' && path === '/user') out = { ...out, stdout: out.stdout.replace(/x-oauth-scopes:.*\r?\n/i, 'x-oauth-scopes: repo, read:org\r\n') };
    if (variant === 'repo-only-rulesets' && /^\/orgs\/[^/]+\/rulesets\//.test(path)) out = rewrite(out, body => ({ ...body, bypass_actors: [] }));
    if (variant === 'page-two-unread' && path.includes('page=2') && out.code !== 0) out = { code: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n[]' };
    return out;
  } };
  if (variant === 'follow-symlink') result.fs = new Proxy(options.fs, { get(target, key) {
    if (key === 'lstat') return path => target.stat(path);
    if (key === 'realpath') return async path => path;
    return target[key];
  } });
  if (variant === 'skip-second-pass') {
    const responses = new Map(), modified = result.run;
    result.run = async (exe, args, opts) => {
      const key = args.at(-1);
      if (!responses.has(key)) responses.set(key, await modified(exe, args, opts));
      return responses.get(key);
    };
  }
  return result;
}
export async function inventory(options) {
  if (variant === 'read-gh-config') await options.fs.readFile(join(options.home, '.config/gh/hosts.yml'));
  if (variant === 'token-read') await options.fs.readFile(join(options.home, '.claude/github-app-token'));
  return safe.inventory(unsafeOptions(options));
}
export async function aggregate(options) {
  const out = await safe.aggregate(unsafeOptions(options));
  if (['drop-root', 'trust-persisted-findings', 'loose-metadata', 'mix-runs', 'accept-stale'].includes(variant)) return complete(out);
  if (variant === 'complete-with-findings-as-complete' && out.exitCode === 10) return complete(out);
  return out;
}
export async function admissionCheck(options) {
  if (variant === 'trust-persisted-result') return { result: 'COMPLETE', exitCode: 0, allowed: true };
  return safe.admissionCheck(unsafeOptions(options));
}
export function childEnvironment(home) {
  return variant === 'inherit-env' ? { ...safe.childEnvironment(home), GH_TOKEN: process.env.GH_TOKEN, WE_OPERATOR_LOGINS: process.env.WE_OPERATOR_LOGINS } : safe.childEnvironment(home);
}
export async function spawnBounded(exe, argv, opts) {
  if (variant === 'shell-true') return new Promise(done => {
    const child = spawn(exe, argv, { env: opts.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', b => { stdout += b; });
    child.on('close', code => done({ stdout, code }));
  });
  // Keep the negative adapter probe bounded even when its requested deadline is ignored.
  if (variant === 'no-timeout') return safe.spawnBounded(exe, ['0.3'], { ...opts, timeoutMs: 1000 });
  return safe.spawnBounded(exe, argv, opts);
}
export const defaultRunner = spawnBounded;
export function validateRecord(record) {
  if (variant === 'fatal-needs-login' && record.fatal && record.readerLogin === null) return false;
  return safe.validateRecord(record);
}
export async function emit(c, kind, value, path) {
  if (variant === 'redact-and-pass' && kind === 'inventory') {
    // Deliberately missing the final serialized-content check.
    await c.fs.writeFile(path, JSON.stringify(value), { flag: 'wx' });
    return value;
  }
  return safe.emit(c, kind, value, path);
}
