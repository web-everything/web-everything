/** Compact PR digest computation and operation declaration; all GitHub and filesystem IO is injected. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const PR_DIGEST_OP = 'pr-digest';
export const digestLine = (value, limit = 200) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
export const cacheHeader = (head, lastComment) => `<!-- pr-digest cache: head=${head} lastComment=${lastComment} v=1 -->`;
const changes = /review\s*[—–-]\s*changes requested/i;
const review = /review\s*[—–-]\s*(changes requested|accepted)|Mandatory review owner|ADVISORY REVIEW/i;
const headIn = body => body.match(/(?:head|rev)[\s=:`"']+([a-f0-9]{7,40})\b/i)?.[1] ?? null;
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

function rulingRecord(body) {
  const encoded = body.match(/<!-- mandatory-referrals-v1: (\S+) -->/);
  const operator = body.match(/<!-- mandatory-referral-operator-ruling-v1: ([A-Za-z0-9+/=]+) -->/);
  try {
    if (encoded) return JSON.parse(decodeURIComponent(encoded[1]));
    if (operator) return JSON.parse(Buffer.from(operator[1], 'base64').toString('utf8'));
  } catch { return { head: headIn(body), rulings: [], incomplete: true }; }
  const start = body.search(/Rulings:\s*\[/i);
  const rulings = start < 0 ? [] : arrayAfter(body, body.indexOf('[', start));
  const visible = [...body.matchAll(/^\d+\.\s*\*\*(not-real|card|block)\*\*/gm)].map(m => ({ result: m[1] }));
  return { head: headIn(body), rulings: Array.isArray(rulings) && rulings.length ? rulings : visible, incomplete: start >= 0 && !Array.isArray(rulings) };
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
export function renderPrDigest({ pr, comments, lastComment, ledger = [], daemon = [] }) {
  const head = pr.headRefOid;
  const labels = pr.labels.map(l => typeof l === 'string' ? l : l.name);
  const rows = comments.filter(c => c.trusted).map(c => ({ ...c, body: String(c.body) }));
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
  const rulings = rows.filter(c => /Rulings:|Operator ruling|Automatic policy ruling/i.test(c.body))
    .map(c => ({ ...rulingRecord(c.body), body: c.body }));
  const rulingLines = rulings.map((r, i) => {
    const superseded = (r.head && !sameHead(r.head, head))
      || rulings.slice(i + 1).some(later => later.head && r.head && !sameHead(later.head, r.head));
    const counts = ['not-real', 'card', 'block'].map(result => `${result}=${(r.rulings ?? []).filter(x => x.result === result).length}`).join(' ');
    return `${r.head?.slice(0, 12) ?? 'head unknown'} ${counts}${r.incomplete ? ' (incomplete; inspect GitHub thread)' : ''}${superseded ? ' (superseded)' : ''}`;
  });
  const lastReset = rows.findLastIndex(c => /re-armed for re-review|fix-end/i.test(c.body));
  const sendbacks = rows.map((c, i) => ({ c, i })).filter(({ c, i }) => i > lastReset && changes.test(c.body));
  const evidenceAfter = i => rows.slice(i + 1).some(c => /evidence/i.test(c.body) && /(?:fix-\d+|worker|fix agent|fixer)/i.test(c.body));
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
  for (const c of rows) {
    if (/Mandatory review owner/i.test(c.body)) {
      const r = rulingRecord(c.body);
      if (!r.head || sameHead(r.head, head)) {
        for (const f of r.referrals ?? []) if (typeof f.key === 'string') referrals.add(f.key);
        for (const m of c.body.matchAll(/^[-*]\s*(\[.*?\]):/gm)) referrals.add(m[1]);
      }
    }
  }
  for (const r of rulings) if (!r.head || sameHead(r.head, head)) for (const x of r.rulings ?? []) if (x.key) ruled.add(x.key);
  const unresolved = [...referrals].some(key => !ruled.has(key)) || rulings.some(r => r.incomplete && (!r.head || sameHead(r.head, head)));
  const failing = /^(?:failed|failure|error|blocked|exhausted)$/i.test(ledger.at(-1)?.outcome ?? '');
  const blocked = missingEvidence ? 'open send-back without evidence'
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

export function prDigestOperation({ readDigest } = {}) {
  if (typeof readDigest !== 'function') throw new TypeError('pr-digest needs a readDigest reader');
  const fields = ['pr', 'all', 'out-dir', 'ledger', 'daemon-log'];
  return op(PR_DIGEST_OP, {
    input: Object.fromEntries(fields.map(name => [name, { type: name === 'pr' ? 'number' : name === 'all' ? 'boolean' : 'string', required: false }])),
    verdictFrom: 'assess',
    read: compute({ reads: fields.map(f => `input.${f}`), fn: ({ input }) => {
      if ((input.pr != null) === Boolean(input.all) || (input.pr != null && (!Number.isSafeInteger(input.pr) || input.pr <= 0))) {
        throw new TypeError('pr-digest: supply exactly one of --pr=<positive integer> or --all');
      }
      return readDigest(input);
    } }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => findings.read }),
  });
}

export function finishPrDigest({ run, code, lines, json = false }) {
  if (!run?.verdict?.results || code) return { code, lines };
  const { results, all } = run.verdict;
  return { code, lines: json ? [JSON.stringify(run.verdict)] : all
    ? [...results.map(r => `#${r.pr} ${r.status}`), `${results.length} PRs: ${results.filter(r => r.status === 'written').length} written, ${results.filter(r => r.status === 'cached').length} cached`]
    : results.map(r => `${digestLine(r.path)} ${r.status}`) };
}
