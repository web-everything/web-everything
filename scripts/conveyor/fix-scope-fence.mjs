/** Deterministic repair scope fence. Operator prose is data; only explicit removal markers are executable policy. */
import { coversFile } from '../readiness/scope-lease.mjs';
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { isOperatorAuthored } from '../lib/marker-authorship.mjs';

export function resolveScopeFence({ env = process.env, tool = readSettings().fix, platform } = {}) {
  const bool = v => v === undefined ? undefined : /^(true|on|1)$/i.test(v) ? true : /^(false|off|0)$/i.test(v) ? false : v;
  const result = cascadePolicy('fix.scopeFence', tool?.scopeFence, {
    standard: { enabled: true, mode: 'stand-down' },
    platform: (platform ?? platformPreference('fix', { env }))?.scopeFence ?? {}, env,
    envValues: { enabled: bool(env.WE_FIX_SCOPE_FENCE_ENABLED), mode: env.WE_FIX_SCOPE_FENCE_MODE },
    valid: { enabled: v => typeof v === 'boolean', mode: v => ['stand-down', 'warn'].includes(v) },
  });
  return { ...result, value: { scopeFence: result.value },
    sources: Object.fromEntries(Object.entries(result.sources).map(([k, v]) => [`scopeFence.${k}`, v])) };
}

export function removalMarkers(text) {
  return [...String(text ?? '').matchAll(/(?:^|\n)\s*(?:<!--\s*)?scope-removed:\s*([^\n]*?)(?:\s*-->)?(?=\n|$)/g)]
    .flatMap(m => m[1].split(/[,\s]+/)).filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
}

export function operatorScope(comments = []) {
  const notes = [], removed = [];
  for (const c of comments) {
    if (!isOperatorAuthored(c) || !/^🔁 review — changes requested/.test(c.body ?? '')) continue;
    const lines = c.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:>\s*)?(?:Out of scope:|scopeNotes:)/i.test(lines[i])) {
        notes.push(lines[i]);
        while (i + 1 < lines.length && /^\s*(?:[-*]|\d+\.)\s/.test(lines[i + 1])) notes.push(lines[++i]);
      } else if (/\bx[a-z0-9]+ carries\b/i.test(lines[i])) notes.push(lines[i]);
    }
    removed.push(...removalMarkers(c.body));
  }
  return { notes, removed: [...new Set(removed)] };
}

export function scopeBrief(scope, { notes = [], removed = [] } = {}) {
  return `## Declared repair scope\n\n${scope.join(', ')}\n\n${notes.join('\n')}\n${removed.length ? `scope-removed: ${removed.join(', ')}\n` : ''}\nStay inside this scope; anything else → stand down with a scope-increase request.\n\n`;
}

export function scopeFenceDecision({ scope = [], repo, paths = [], patch = '', removed = [], policy }) {
  if (policy?.enabled === false) return { action: 'push', violations: [] };
  const allowed = scope.filter(s => !s.includes(':') || s.startsWith(`${repo}:`)).map(s => s.replace(/^[^:]+:/, '').split('#')[0]);
  const outside = paths.filter(p => !allowed.some(s => coversFile(`${repo}:${s}`, `${repo}:${p}`) || (!/[*?]/.test(s) && p.startsWith(`${s.replace(/\/$/, '')}/`))));
  const additions = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++ ')).join('\n');
  const identifiers = [...new Set(removed)].filter(id => additions.match(/[A-Za-z_$][\w$]*/g)?.includes(id));
  const violations = [...outside.map(p => `outside declared scope: ${p}`), ...identifiers.map(id => `re-adds operator-removed identifier: ${id}`)];
  if (!violations.length) return { action: 'push', violations };
  return { action: policy?.mode === 'warn' ? 'warn' : 'stand-down', violations,
    reason: `scope-increase request: proposed repair ${violations.join('; ')}. Operator approval is required to widen this PR's scope.` };
}

/** The same gate wraps early, green and salvage pushes. Failures never fall through to the push sink. */
export function fencedPush({ readContext, readDiff, push, standDown, note, policy }) {
  if (policy.enabled === false) return push();
  let context, decision;
  try {
    context = readContext();
    decision = scopeFenceDecision({ ...context, ...readDiff(context), policy });
  } catch (e) {
    return { ok: false, scopeFence: true, transient: true, reason: `scope fence evidence unavailable: ${e.message}` };
  }
  if (decision.action === 'stand-down') {
    standDown(decision.reason, context);
    return { ok: false, scopeFence: true, terminal: true, reason: decision.reason };
  }
  if (decision.action === 'warn') note(`Scope fence warning: ${decision.reason}`, context);
  return push();
}
