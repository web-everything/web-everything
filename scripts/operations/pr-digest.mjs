/** Compact PR digest computation and operation declaration; all GitHub and filesystem IO is injected. */
import { op } from './registry.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';

export const PR_DIGEST_OP = 'pr-digest';
export const PR_DIGEST_EFFECT = 'pr-digest.write';
export const digestLine = (value, limit = 200) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
export const cacheHeader = (head, lastComment) => `<!-- pr-digest cache: head=${head} lastComment=${lastComment} v=1 -->`;
const RESULTS = ['not-real', 'card', 'block'];
const changes = /review\s*[—–-]\s*changes requested/i;
const review = /review\s*[—–-]\s*(changes requested|accepted)|Mandatory review owner|ADVISORY REVIEW/i;
const headIn = body => body.match(/(?:head|rev)[\s=:`"']+([a-f0-9]{7,40})\b/i)?.[1]?.toLowerCase() ?? null;
const sameHead = (a, b) => Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));

/** Extract JSON arrays without evaluating prose; bracket counting respects JSON string escapes. */
function arrayAfter(text, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Track code fences before the trailer; an unfinished example cannot supply lifecycle evidence. */
function trailerInsideCodeFence(lines) {
  let fence = null;
  for (const line of lines.slice(0, -1)) {
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
  }
  return fence !== null;
}

function rulingRecord(body, pr, validateRuling) {
  const incomplete = () => ({ head: headIn(body), rulings: [], incomplete: true });
  const lines = body.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const trailer = lines.at(-1);
  const encoded = trailer.match(/^<!-- mandatory-referrals-v1: (\S+) -->$/);
  const operator = trailer.match(/^<!-- mandatory-referral-operator-ruling-v1: ([A-Za-z0-9+/=]+) -->$/);
  try {
    if (encoded || operator) {
      if (trailerInsideCodeFence(lines)) return incomplete();
      const record = JSON.parse(encoded ? decodeURIComponent(encoded[1]) : Buffer.from(operator[1], 'base64').toString('utf8'));
      const valid = record?.version === 1 && record.repo === 'web-everything/web-everything' && record.pr === pr.number
        && /^[a-f0-9]{40}$/.test(record.head) && Array.isArray(record.rulings)
        && record.rulings.every(x => x && typeof x.key === 'string' && x.key.trim() && RESULTS.includes(x.result));
      // The IO boundary injects the full shared validators without giving this declaration an effectful import graph.
      return valid && validateRuling(record, Boolean(encoded), body)
        ? { ...record, runId: encoded ? record.runId : undefined } : incomplete();
    }
  } catch { return incomplete(); }
  if (/<!--\s*mandatory-referral(?:s-v1|-operator-ruling-v1)\b/.test(body)) return incomplete();
  const start = body.search(/Rulings:\s*\[/i);
  const rulings = start < 0 ? [] : arrayAfter(body, body.indexOf('[', start));
  const visible = [...body.matchAll(/^\d+\.\s*\*\*(not-real|card|block)\*\*/gm)].map(m => ({ result: m[1] }));
  if (start >= 0 && (!Array.isArray(rulings) || rulings.some(x => !x || !RESULTS.includes(x.result)))) return incomplete();
  return { head: headIn(body), rulings: Array.isArray(rulings) && rulings.length ? rulings : visible, informational: true };
}

function findings(body) {
  const out = [];
  for (const match of body.matchAll(/\[\s*"[^"\n]+"\s*,\s*"/g)) {
    const a = arrayAfter(body, match.index);
    if (Array.isArray(a) && typeof a[1] === 'string' && (Number.isInteger(a[2]) || a[2] === '')) {
      out.push(`${a[1]}:${a[2] || '?'} (unknown, ${a[0]})`);
    }
  }
  for (const m of body.matchAll(/\(([^,\n]+),\s*([^\)\n]+)\)\s*`([^`\n]+)`/g)) {
    out.push(`${m[3]} (${m[2]}, ${m[1]})`);
  }
  return [...new Set(out)].slice(0, 6);
}

function redTeam(body, number) {
  const marker = body.match(/^<!-- we:red-team-advisory pr=(\d+) rev=([a-f0-9]{7,40}) -->/);
  if (!marker || Number(marker[1]) !== number) return null;
  const outcome = body.match(/^###? .*red team.*$/im)?.[0].replace(/^#+\s*/, '') ?? 'outcome unknown';
  const confirmed = Number(body.match(/(\d+) confirmed/i)?.[1] ?? 0);
  const breaks = [];
  for (const block of body.split(/(?=^\d+\. )/m)) {
    if (!/\[\*\*confirmed\*\*\]/i.test(block)) continue;
    const path = block.match(/`([^`\n]+)`/)?.[1] ?? 'location unknown';
    const scenario = block.match(/Scenario:\s*([^\n]+)/i)?.[1]?.split(/(?<=[.!?])\s/)[0] ?? 'scenario unavailable';
    breaks.push(`${path} - ${scenario}`);
  }
  return { head: marker[2], outcome, confirmed, breaks };
}

/** Fold trusted lifecycle observations into at most 60 lines, reserving space for every section. */
export function renderPrDigest({ pr, comments, lastComment, ledger = [], daemon = [], validateRuling = () => false }) {
  const head = pr.headRefOid;
  const labels = pr.labels.map(l => typeof l === 'string' ? l : l.name);
  const rows = comments.filter(isTrustedMarkerAuthor).filter(c => c.trusted).map(c => ({ ...c, body: String(c.body) }));
  const purpose = pr.body.replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .map(s => s.trim()).filter(s => s && !/^(#|```|---|\[\/?.*\])/.test(s)).slice(0, 2);
  let round = 'n/a';
  for (const c of rows) {
    const r = c.body.match(/round\s+(\d+)\s*(?:\/|of)\s*(\d+)/i);
    const cap = c.body.match(/maxLiveReviewRounds[\s`"':=]+(\d+)/i);
    if (r) round = `${r[1]}/${r[2]}`;
    else if (cap) round = `?/${cap[1]}`;
  }
  const latest = rows.filter(c => review.test(c.body)).at(-1);
  const verdict = !latest ? 'none' : /changes requested/i.test(latest.body) ? 'changes requested'
    : /review\s*[—–-]\s*accepted|ADVISORY REVIEW[^\n]*accepted/i.test(latest.body) ? 'accepted'
      : /Mandatory review owner/i.test(latest.body) ? 'mandatory referral review' : 'advisory review';
  const rulings = rows.filter(c => /Rulings:|Operator ruling|Automatic policy ruling|<!--\s*mandatory-referral(?:s-v1|-operator-ruling-v1)\b/i.test(c.body))
    .map(c => ({ ...rulingRecord(c.body, pr, validateRuling), body: c.body }));
  const rulingLines = rulings.map((r, i) => {
    const superseded = (r.head && !sameHead(r.head, head))
      || rulings.slice(i + 1).some(later => later.head && r.head && !sameHead(later.head, r.head));
    const counts = ['not-real', 'card', 'block'].map(result => `${result}=${(r.rulings ?? []).filter(x => x.result === result).length}`).join(' ');
    return `${r.head?.slice(0, 12) ?? 'head unknown'} ${counts}${r.informational ? ' (informational only)' : ''}${r.incomplete ? ' (incomplete; inspect GitHub thread)' : ''}${superseded ? ' (superseded)' : ''}`;
  });
  // Releasing a claim or re-arming review never proves that a send-back was addressed.
  const lastReset = -1;
  const sendbacks = rows.map((c, i) => ({ c, i })).filter(({ c, i }) => i > lastReset && changes.test(c.body));
  const evidenceAfter = i => rows[i]?.id != null && rows.slice(i + 1).some(c => {
    const markers = /^(?:## (?:🔧 )?Fix evidence\r?\n(?:\r?\n)*)?(?:Head: `[a-f0-9]{7,40}`[ \t]*\r?\n(?:\r?\n)*)?((?:<!-- addresses-operator-send-back: [^\s<>]+ -->[ \t]*(?:\r?\n|$))+)/.exec(c.body)?.[1] ?? '';
    const addressed = [...markers.matchAll(/<!-- addresses-operator-send-back: ([^\s<>]+) -->/g)].map(m => m[1]);
    const requestedHead = headIn(rows[i].body);
    const evidenceHead = c.body.replace(/<!--[\s\S]*?-->/g, ' ').match(/\bHead:\s*`([a-f0-9]{7,40})`/i)?.[1]?.toLowerCase() ?? head;
    return addressed.includes(String(rows[i].id)) && (!requestedHead || !sameHead(requestedHead, evidenceHead));
  });
  const missingEvidence = sendbacks.some(({ i }) => !evidenceAfter(i)) || (labels.includes('review:changes') && !sendbacks.length && !evidenceAfter(lastReset));
  const teams = new Map();
  for (const c of rows) { const team = redTeam(c.body, pr.number); if (team) teams.set(team.head, team); }
  const redLines = [];
  for (const t of [...teams.values()].reverse()) {
    if (redLines.length >= 5) break;
    redLines.push(`${t.head.slice(0, 12)}: ${t.outcome}`);
    redLines.push(...t.breaks.slice(0, 5 - redLines.length));
  }
  const referrals = new Set();
  const ruled = new Set();
  const currentRulings = new Map();
  for (const c of rows) {
    if (/Mandatory review owner|<!--\s*mandatory-referrals-v1:/i.test(c.body)) {
      const r = rulingRecord(c.body, pr, validateRuling);
      if (!r.head || sameHead(r.head, head)) {
        for (const f of r.referrals ?? []) if (typeof f.key === 'string') referrals.add(JSON.stringify([r.runId, f.key]));
        for (const m of c.body.matchAll(/^[-*]\s*(\[.*?\]):/gm)) referrals.add(JSON.stringify([r.runId, m[1]]));
      }
    }
  }
  // Comments arrive chronologically; only the latest validated ruling for each bound identity decides.
  for (const r of rulings) if (!r.incomplete && !r.informational && sameHead(r.head, head)) {
    for (const x of r.rulings ?? []) if (x.key) {
      const runId = r.runId ?? x.runId;
      ruled.add(JSON.stringify([runId, x.key]));
      currentRulings.set(JSON.stringify([r.head, runId, x.key]), x);
    }
  }
  const unresolved = [...referrals].some(key => !ruled.has(key)) || rulings.some(r => r.incomplete && (!r.head || sameHead(r.head, head)));
  const failing = /^(?:failed|failure|error|blocked|exhausted)$/i.test(ledger.at(-1)?.outcome ?? '');
  const blocked = missingEvidence ? 'open send-back without evidence'
    : [...currentRulings.values()].some(x => x.result === 'block') ? 'blocking ruling'
      : unresolved ? 'referrals need a ruling'
      : labels.includes('review:human') ? 'human review required'
        : [...teams.values()].some(t => sameHead(t.head, head) && (t.confirmed > 0 || t.breaks.length)) ? 'red-team confirmed break'
          : rows.some(c => /merge conflict|CONFLICTING/i.test(c.body)) ? 'merge conflict'
            : failing ? 'failing fix-loop outcome' : 'nothing detected';
  const lines = [cacheHeader(head, lastComment), `# PR #${pr.number}: ${pr.title}`, '## Purpose',
    ...purpose, `Head: ${head.slice(0, 12)} | Labels: ${labels.join(', ') || 'none'} | Round/cap: ${round}`,
    '## Latest review verdict', verdict,
    ...findings(latest?.body ?? ''), '## Rulings', ...(rulingLines.slice(-5).length ? rulingLines.slice(-5) : ['none']),
    '## Open send-backs', `review:changes label: ${labels.includes('review:changes') ? 'yes' : 'no'}`,
    ...(sendbacks.length ? sendbacks.slice(-5).map(({ i }) => `changes requested; evidence: ${evidenceAfter(i) ? 'posted' : 'missing'}`) : labels.includes('review:changes') ? [`label-only send-back; evidence: ${evidenceAfter(lastReset) ? 'posted' : 'missing'}`] : ['none']),
    '## Red-team results by head', ...(redLines.length ? redLines.slice(-5) : ['none']),
    '## Fix-loop outcomes', ...(ledger.length ? ledger.slice(-5).map(r => `${r.at} ${r.outcome} infra=${r.infra ?? 'n/a'} ${String(r.head ?? '').slice(0, 7)} ${digestLine(r.reason, 100)}`) : ['none']),
    '## Daemon decisions (last 2h)', ...(daemon.length ? daemon.slice(-5).map(l => digestLine(l, 160)) : ['none']),
    `Blocked on: ${blocked}`];
  return `${lines.map(l => digestLine(l)).join('\n')}\n`;
}

export function prDigestOperation() {
  const fields = ['pr', 'all', 'out-dir', 'ledger', 'daemon-log'];
  return op(PR_DIGEST_OP, {
    input: Object.fromEntries(fields.map(name => [name, { type: name === 'pr' ? 'number' : name === 'all' ? 'boolean' : 'string', required: false }])),
    verdictFrom: 'assess',
    read: compute({ reads: fields.map(f => `input.${f}`), fn: ({ input }) => {
      if ((input.pr != null) === Boolean(input.all) || (input.pr != null && (!Number.isSafeInteger(input.pr) || input.pr <= 0))) {
        throw new TypeError('pr-digest: supply exactly one of --pr=<positive integer> or --all');
      }
      return input;
    } }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => findings.read }),
    write: effectStep({ reads: ['verdict'], effects: ({ verdict }) => [
      { type: PR_DIGEST_EFFECT, idempotent: true, payload: verdict },
    ] }),
  });
}

export function finishPrDigest({ run, code, lines, json = false }) {
  if (code) return { code, lines };
  const effect = run?.effects?.find(e => e.type === PR_DIGEST_EFFECT);
  if (effect?.status !== 'applied' || !Array.isArray(effect.result?.results)) {
    return { code: 1, lines: [...lines, 'pr-digest: incomplete; digest write did not complete; retry the operation'] };
  }
  const { results, all } = effect.result;
  return { code, lines: json ? [JSON.stringify(effect.result)] : all
    ? [...results.map(r => `#${r.pr} ${r.status}`), `${results.length} PRs: ${results.filter(r => r.status === 'written').length} written, ${results.filter(r => r.status === 'cached').length} cached`]
    : results.map(r => `${digestLine(r.path)} ${r.status}`) };
}
