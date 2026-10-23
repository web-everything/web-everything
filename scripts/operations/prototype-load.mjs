/**
 * @file Declared prototype admission and pure evidence decisions.
 * WHY (incident 2026-10-22): combined tops repeated tests, reverted main fixes three times,
 * and removed registrations before replacement admission. Keep comparisons explicit and swaps ordered.
 */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
export const PROTOTYPE_LOAD_OP = 'prototype-load';
export const PROTOTYPE_LOAD_EFFECT = 'prototype-load.apply';
export const safeRegistrationRef = (ref) => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
  && !/\.\.|\/\/|\/\.|@\{|\.$|\/$|\.lock(?:\/|$)/.test(ref);
export const safeRef = (ref) => safeRegistrationRef(ref) && ref.startsWith('lane/');
export const validSha = (sha) => /^[a-f0-9]{40}$/i.test(sha || '');
export function jsonLines(text) {
  return String(text).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
export function readyEvidence(records, input) {
  if (input.testsRun?.trim() && /^NOT WEAKENED$/i.test(input.audit || '')) return { source: 'arguments', testsRun: input.testsRun };
  const record = records.find((r) => r?.ref === input.branch && r.sha === input.sha && r.tests === 'green' && /^NOT WEAKENED$/i.test(r.audit || ''));
  return record ? { source: 'ready-record', record } : null;
}
/** Historical registration admits no test claim; the daemon rebuild smoke remains the gate. */
export function combinedReadyEvidence(records, parts, events, missingRecords = false) {
  if (!parts.length) return null;
  const first = Date.parse(records[0]?.at);
  let historical = false;
  for (const { ref, sha } of parts) {
    if (readyEvidence(records, { branch: ref, sha })) continue;
    // Use the latest lifecycle event: an old add cannot grandfather a later re-registration.
    const lifecycle = events.filter((e) => e?.ref === ref && ['added', 'removed', 'conflict-dropped'].includes(e.kind)).at(-1);
    const registered = Date.parse(lifecycle?.at);
    if (lifecycle?.kind !== 'added' || !Number.isFinite(registered)
      || (!missingRecords && (!Number.isFinite(first) || registered >= first))) return null;
    historical = true;
  }
  return { source: historical ? 'registered-before-records' : 'all-parts-ready', parts };
}
/** Include BOTH sides of renames/copies; NUL output preserves whitespace and quoted paths. */
export function changedPaths(text) {
  const fields = String(text).split('\0');
  const paths = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status) || !fields[i]) throw new Error('unreadable name-status diff');
    paths.push(fields[i++]);
    if (/^[RC]/.test(status)) { if (!fields[i]) throw new Error('incomplete rename'); paths.push(fields[i++]); }
  }
  return [...new Set(paths)].sort();
}
export function comparePaths(own, effective) {
  return { outside: effective.filter((p) => !own.includes(p)), missing: own.filter((p) => !effective.includes(p)) };
}
export function nextMergeRef(branch, remote) {
  const prefix = `refs/heads/${branch}-m`;
  const numbers = String(remote).split(/\r?\n/).map((line) => line.split(/\s+/)[1])
    .filter((ref) => ref?.startsWith(prefix)).map((ref) => ref.slice(prefix.length)).filter((s) => /^\d+$/.test(s)).map(BigInt);
  return `${branch}-m${numbers.reduce((max, n) => n > max ? n : max, 0n) + 1n}`;
}
export function refusal(records, ref, since, alerts = false) {
  return records.find((r) => r && Date.parse(r.at) >= since && (r.ref === ref || (alerts && JSON.stringify(r).includes(ref)))
    && (alerts ? /reject|drop|refus|conflict/i.test(JSON.stringify(r)) : /removed|dropped/.test(r.kind || r.event || r.type || '')));
}
export function prototypeLoadOperation() {
  const input = Object.fromEntries(['branch', 'sha', 'daemon', 'why', 'tests-run', 'audit'].map((key) => [key, { type: 'string', required: false, default: '' }]));
  input['dry-run'] = { type: 'boolean', required: false, default: false };
  return op(PROTOTYPE_LOAD_OP, {
    input, verdictFrom: 'assess',
    load: effect({ reads: Object.keys(input).map((key) => `input.${key}`),
      effects: ({ input: values }) => [{ type: PROTOTYPE_LOAD_EFFECT,
        payload: { ...values, testsRun: values['tests-run'], dryRun: values['dry-run'] }, idempotent: false }] }),
    assess: compute({ reads: ['findings.load'], fn: ({ findings }) => {
      const entry = findings.load?.effects?.[0];
      if (entry?.status !== 'applied' || !entry.result) throw new Error('prototype-load: transaction did not complete');
      return entry.result;
    } }),
  });
}
