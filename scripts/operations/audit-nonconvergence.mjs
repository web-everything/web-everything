/** @file Audit lineage routing only: new finding identities require a design pass. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { parseFindingLocation } from '../lib/finding-location.mjs';

export const NONCONVERGENCE_SIGNATURE = 'audit-nonconvergence';

const clean = text => stripVTControlCharacters(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

// Shared by live parsing, persisted audit lookup and lineage validation.
export function hasConflictingVerdict(verdict, findings) {
  const opposite = verdict === 'NOT WEAKENED' ? 'WEAKENED' : 'NOT WEAKENED';
  return findings.some(line => typeof line === 'string' && [...line.split(LINE_BREAK), ...clean(line).split(LINE_BREAK)].some(part =>
    clean(part).normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').trim() === opposite));
}

export function findingKeysOf(findings) {
  return findings.map(text => {
    try {
      const { file } = parseFindingLocation(text) ?? {};
      if (!file) throw new Error('invalid finding location');
      // The ledger text carries no class, so the first three content words stand in for it (file-only keys collapse real rounds).
      const words = (text.split(/\s[—-]\s/)[1] ?? '').toLowerCase().match(/[a-z]{5,}/g)?.slice(0, 3).join('-') ?? '';
      const cls = text.match(/\b(B[1-7]|E[12]|D[1-3]|X[12])\b/)?.[0] ?? 'X1';
      return `${file}|<top>|${cls}${words ? `|${words}` : ''}`;
    } catch {
      return `text|${createHash('sha256').update(String(text).toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)}`;
    }
  });
}

const distinctHeads = rounds => rounds.filter((round, index) => !rounds.slice(index + 1).some(later => later?.head === round?.head));

export function lineageRounds(records, ref, questionHash) {
  return records.filter(record => record?.ref === ref && record.questionHash === questionHash);
}

export function assessLineage(rounds) {
  if (rounds.some(round => !round || typeof round !== 'object' || typeof round.head !== 'string'
    || !/^[a-f0-9]{40}$/i.test(round.head) || !['WEAKENED', 'NOT WEAKENED'].includes(round.verdict)
    || !Array.isArray(round.findings) || round.findings.some(text => typeof text !== 'string')
    || (round.verdict === 'WEAKENED' && !round.findings.length)
    || hasConflictingVerdict(round.verdict, round.findings))) {
    return { escalate: true, reason: 'unreadable-lineage', streak: 0, rounds: rounds.length };
  }
  rounds = distinctHeads(rounds);
  const n = rounds.length;
  const seen = new Set();
  let streak = 0, newKeys = [];
  for (const round of rounds) {
    // Passing commentary resets the streak and cannot reserve a future finding's identity.
    const keys = round.verdict === 'WEAKENED' ? [...new Set(findingKeysOf(round.findings))] : [];
    newKeys = keys.filter(key => !seen.has(key));
    streak = round.verdict === 'WEAKENED' && newKeys.length ? streak + 1 : 0;
    keys.forEach(key => seen.add(key));
  }
  return { streak, rounds: n, escalate: streak >= 3, newKeys };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
  const { readFileSync } = await import('node:fs');
  const heads = new Set((flags.heads ?? '').split(','));
  const rounds = readFileSync(flags.replay, 'utf8').split(/\r?\n/).filter(line => line.trim())
    .map(line => JSON.parse(line)).filter(record => heads.has(record.head));
  rounds.forEach((round, index) => {
    const result = assessLineage(rounds.slice(0, index + 1));
    const head = String(round.head).replace(/[^a-fA-F0-9]/g, '').slice(0, 8);
    const verdict = ['WEAKENED', 'NOT WEAKENED'].includes(round.verdict) ? round.verdict : 'UNREADABLE';
    console.log(`round ${index + 1} ${head} ${verdict} newKeys=${result.newKeys?.length ?? 0} streak=${result.streak}`);
  });
  if (assessLineage(rounds).escalate) console.log(`${NONCONVERGENCE_SIGNATURE}: stop patching, a design pass is required`);
}
