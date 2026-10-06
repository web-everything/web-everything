#!/usr/bin/env node
/**
 * @file scripts/conveyor/status-artifact.mjs
 * @description The CONVEYOR STATUS-ARTIFACT generator (epic #2612) — the INTERIM status surface the conveyor
 *   maintains WHILE the product console UI (#2527 / #2505 / #2555) does not exist. It reads live conveyor state
 *   (`conveyor-state.mjs` + `dispatch-plan.mjs` + `lane-pool.mjs status` + `gh pr list` + a backlog scan) and
 *   emits a self-contained HTML status board to STDOUT: the KPI row, the four-stage flow, the lane pool (with
 *   ghost-lease flagging), an "Epics — progress" section with a per-epic child-state rollup, the buildable-items
 *   table (epic rows excluded — they live in the Epics section), and a merged-today section. The conveyor
 *   publishes that HTML as an Artifact on a ~5-min heartbeat (SKILL §8) until the session-free product board
 *   lands.
 *
 * READ-ONLY / DETERMINISTIC: it shells only reads (`node scripts/...`, `git log`, `gh pr list`) and prints — it
 *   mutates NOTHING (no repo write, no PR, no merge). The PUBLISH step is the session's (the Artifact tool is a
 *   session capability), not this script's — see the SKILL's "Interim status surface" section.
 *
 * DEPENDENCY-FREE: Node built-ins + `gh` / `git` only — no npm deps. The CSS is inlined below (CSS constant), so
 *   the emitted page is one self-contained document with no sibling asset to ship.
 *
 * Usage: node scripts/conveyor/status-artifact.mjs > conveyor-status.html   (run from the WE repo root)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { localToday } from '../lib/local-date.mjs';

const REPO = 'web-everything/web-everything';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const j = (c) => { const o = sh(c); try { return JSON.parse(o); } catch { return null; } };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- live reads ----
const state = j('node scripts/readiness/conveyor-state.mjs --json') || {};
const plan = j('node scripts/readiness/dispatch-plan.mjs --json') || { launch: [], held: [] };
const openPRs = j(`gh pr list --repo ${REPO} --state open --json number,title,labels --limit 60`) || [];
const today = localToday();
const mergedToday = [...new Set((sh('git log origin/main --since=midnight --format=%s')
  .match(/WE #(\d+)/g) || []).map((m) => m.replace('WE #', '')))];

// map num -> open PR (with labels)
const prByNum = {};
for (const p of openPRs) {
  const m = (p.title || '').match(/#?(\d{3,5})|WE #(\d+)/);
  const num = m ? (m[1] || m[2]) : null;
  const labels = (p.labels || []).map((l) => l.name);
  if (num) prByNum[num] = { pr: p.number, labels };
}

// ---- backlog scan ----
const KW = /conveyor|dispatch-plan|delivery-agent|lane-pool|lane-drain|pr-watch|pr-land|readiness\/|rearm-review|review-parked|jury|scope-lease|infra-blocked|mechanize|headless runner|self-driving|escalation|disposition|drain|orchestrat/i;
const files = fs.readdirSync('backlog').filter((f) => f.endsWith('.md'));
const items = [];
for (const f of files) {
  const t = fs.readFileSync('backlog/' + f, 'utf8');
  const fm = (t.split(/^---$/m)[1]) || '';
  const g = (k) => { const m = fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const status = g('status');
  if (status === 'resolved') continue;
  const num = g('num') || f.split('-')[0];
  const title = (g('title') || f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ')).slice(0, 62);
  const workItem = g('workItem'); const type = g('type'); const kind = g('kind'); const size = g('size'); const parent = g('parent');
  const hasScope = /^scope:/m.test(fm);
  const blockedBy = g('blockedBy');
  const digest = g('digest');
  if (!(KW.test(title + ' ' + digest + ' ' + fm) || ['2612', '2677', '2613', '2606', '2636', '2649'].includes(parent))) continue;
  // a short "what it is" summary (digest, else the first substantive body line) + an epic slice-hint (what it needs)
  const bodyText = t.split(/^---$/m).slice(2).join('---');
  const summary = (digest || ((bodyText.match(/^\s*([A-Za-z][^\n]{24,})/m) || [])[1] || '')).replace(/\s+/g, ' ').trim().slice(0, 128);
  let sliceHint = '';
  if ((workItem || kind) === 'epic') {
    if (/\b(open question|unresolved|gated on|blocked on (a )?(decision|fork)|needs? a (design|decision)|design pass|type:\s*decision|awaiting (a )?decision)\b/i.test(bodyText) || /\bdecision\b/i.test(title))
      sliceHint = 'gated on a design decision — /prepare or resolve it first, then /slice';
    else if (/\b(epic of epics|registry of|each .{0,30}(is|its own) .{0,24}epic|sub-epic|roadmap)\b/i.test(bodyText))
      sliceHint = 'roadmap epic — /slice into sub-epics (recursive)';
    else
      sliceHint = 'ready — /slice into buildable stories';
  }
  items.push({ num, title, workItem: workItem || kind || type || 'story', kind, size, parent, hasScope, blockedBy, status, summary, sliceHint });
}

// full-backlog children map: epic num -> { open, total } child stories. Scans ALL backlog
// files (not the conveyor-filtered `items`), so an epic's slice-status is counted against its
// real children. total===0 ⇒ unsliced (needs /slice); total>0 ⇒ storied (waiting on stories).
const childCount = {};
for (const f of files) {
  const t = fs.readFileSync('backlog/' + f, 'utf8');
  const fm = (t.split(/^---$/m)[1]) || '';
  const pm = fm.match(/^parent:\s*(.+)$/m);
  if (!pm) continue;
  const st = ((fm.match(/^status:\s*(.+)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
  for (const p of (pm[1].match(/\d+/g) || [])) {
    childCount[p] = childCount[p] || { open: 0, total: 0 };
    childCount[p].total++;
    if (st !== 'resolved') childCount[p].open++;
  }
}

// leased lanes → item nums (conveyor-<num> sessions). A lease is "building" only if the
// item isn't already merged-today and has no open PR (else it's a ghost lease from a landed item).
const leasedNums = new Set((state.lanes || []).map((l) => String(l.num)).filter((n) => n && n !== 'undefined'));
const isBuilding = (num) => leasedNums.has(String(num)) && !prByNum[num] && !mergedToday.includes(String(num));

// classify live-state
const openNums = new Set(items.map((i) => i.num));
const stateOf = (it) => {
  const pr = prByNum[it.num];
  if (pr) {
    if (pr.labels.includes('review:human')) return ['your-review', 'gate'];
    if (pr.labels.includes('review:accepted')) return ['landing', 'ok'];
    if (pr.labels.includes('review:pending')) return ['in-review', 'review'];
    return ['landing', 'ok'];
  }
  if (mergedToday.includes(it.num)) return ['merged', 'ok'];
  if (isBuilding(it.num)) return ['building', 'build'];
  if (it.kind === 'epic' || it.workItem === 'epic') {
    const c = childCount[it.num];
    return (!c || c.total === 0) ? ['needs-slice', 'needs'] : ['epic', 'held'];
  }
  if (it.kind === 'decision' || it.workItem === 'decision') return ['decision', 'gate'];
  if (!it.hasScope) return ['needs-scope', 'needs'];
  if (it.blockedBy && it.blockedBy.split(/[,\s]+/).some((b) => openNums.has(b.replace('#', '')))) return ['blocked', 'held'];
  return ['ready', 'ready'];
};
for (const it of items) { const [s, c] = stateOf(it); it.state = s; it.cls = c; it.kids = childCount[it.num] || { open: 0, total: 0 }; }

// bucket by epic
const bucket = (it) => {
  const n = +it.num, p = it.parent;
  if (['2612', '2613'].includes(p) || [2609, 2611, 2614, 2620, 2621, 2622, 2643, 2648, 2681, 2684, 2692, 2704].includes(n)) return '#2612 · Conveyor skill';
  if (['2677'].includes(p) || [2699, 2700, 2701, 2702, 2703].includes(n)) return '#2677 · Mechanize core';
  if (['2636', '2649', '2577'].includes(p) || [2575, 2576, 2640, 2641, 2642, 2664, 2665, 2707].includes(n)) return 'Jury · review-to-convergence';
  if (['2606'].includes(p) || [2605, 2661, 2666].includes(n)) return 'Program & health';
  if (/^244[0-9]$|^245[0-9]$|^24[0-1][0-9]$|^25[0-9][0-9]$|^266[0-9]$|2737/.test(it.num)) return 'Drain / lander / review-gate';
  return 'Other';
};
for (const it of items) it.bucket = bucket(it);

// counts
const cnt = (pred) => items.filter(pred).length;
const readyItems = items.filter((i) => i.state === 'ready').map((i) => i.num);
const buildingItems = items.filter((i) => i.state === 'building').map((i) => i.num);
const inReviewItems = items.filter((i) => i.state === 'in-review');   // open PR, review:pending
const landingItems = items.filter((i) => i.state === 'landing');       // open PR, review:accepted, awaiting drain
const mergedOpenItems = items.filter((i) => i.state === 'merged');     // merged today, card not yet resolved
const humanReviewItems = items.filter((i) => i.state === 'your-review'); // open PR, review:human — your gate
const needsScope = cnt((i) => i.state === 'needs-scope');
const gateItems = items.filter((i) => i.state === 'decision' && i.cls === 'gate');
// Buildable remaining backlog: excludes merged-but-open cards AND epics (epic/needs-slice),
// which now live in the dedicated "Epics — progress" section rather than the build list.
const remainingItems = items.filter((i) => i.state !== 'merged' && i.state !== 'epic' && i.state !== 'needs-slice');
const mergedListItems = items.filter((i) => i.state === 'merged').sort((a, b) => +a.num - +b.num); // shown in the dedicated Merged section
const unslicedEpics = items.filter((i) => i.state === 'needs-slice').sort((a, b) => +a.num - +b.num); // actionable: need /slice
const storiedEpics = items.filter((i) => i.state === 'epic').sort((a, b) => +a.num - +b.num);          // no action: waiting on stories

// ---- per-epic child-state rollup ----
// One full-backlog scan → (a) status of every item, (b) each epic's children with the
// frontmatter the classifier needs (status / scope / blockedBy). Children are ANY item whose
// parent references the epic's num — same rule as the childCount loop above.
const statusByNum = {};
const childrenOf = {};
for (const f of files) {
  const t = fs.readFileSync('backlog/' + f, 'utf8');
  const fm = (t.split(/^---$/m)[1]) || '';
  const g = (k) => { const m = fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const cnum = g('num') || f.split('-')[0];
  statusByNum[cnum] = g('status');
  const pm = fm.match(/^parent:\s*(.+)$/m);
  if (!pm) continue;
  const child = { num: cnum, status: g('status'), hasScope: /^scope:/m.test(fm), blockedBy: g('blockedBy') };
  for (const p of (pm[1].match(/\d+/g) || [])) (childrenOf[p] = childrenOf[p] || []).push(child);
}
// a blockedBy is "open" if any referenced num is a known backlog item that isn't resolved / merged-today
const hasOpenBlocker = (blockedBy) => !!blockedBy && blockedBy.split(/[,\s]+/)
  .map((b) => b.replace(/#/g, '').trim()).filter(Boolean)
  .some((b) => (b in statusByNum) && statusByNum[b] !== 'resolved' && !mergedToday.includes(b));
// classify ONE child into a single state, reusing the generator's live maps
const classifyChild = (c) => {
  if (c.status === 'resolved' || mergedToday.includes(String(c.num))) return 'done';
  const pr = prByNum[c.num];
  if (pr) {
    if (pr.labels.includes('review:accepted')) return 'landing';
    if (pr.labels.includes('review:pending') || pr.labels.includes('review:human')) return 'review';
    return 'landing'; // open PR, no review label yet → in flight toward the drain
  }
  if (leasedNums.has(String(c.num))) return 'building';
  if (!c.hasScope) return 'needs-scope';
  if (hasOpenBlocker(c.blockedBy)) return 'blocked';
  return 'ready';
};
const ROLL_ORDER = ['done', 'building', 'review', 'landing', 'ready', 'needs-scope', 'blocked'];
const epicRollup = (epicNum) => {
  const kids = childrenOf[epicNum] || [];
  const by = {}; const inFlight = [];
  for (const c of kids) {
    const s = classifyChild(c);
    by[s] = (by[s] || 0) + 1;
    if (s === 'building' || s === 'review' || s === 'landing') inFlight.push({ num: c.num, state: s });
  }
  return { total: kids.length, by, inFlight };
};
// open epics (unsliced first, then most-in-flight, then num) with their rollup
const openEpics = [...unslicedEpics, ...storiedEpics].map((it) => ({ it, roll: epicRollup(it.num) }));
openEpics.sort((a, b) => {
  const au = a.it.state === 'needs-slice' ? 0 : 1, bu = b.it.state === 'needs-slice' ? 0 : 1;
  return au - bu || b.roll.inFlight.length - a.roll.inFlight.length || +a.it.num - +b.it.num;
});
// render helpers for the Epics — progress section
const ROLL_CLS = { done: 'ok', building: 'build', review: 'review', landing: 'ok', ready: 'ready', 'needs-scope': 'needs', blocked: 'held' };
const rollupPills = (roll) => `<span class="rpill total"><b>${roll.total}</b> total</span>`
  + ROLL_ORDER.filter((s) => roll.by[s]).map((s) => `<span class="rpill ${ROLL_CLS[s]}"><b>${roll.by[s]}</b> ${s}</span>`).join('');
const NOW_WORD = { building: 'build', review: 'review', landing: 'landing' };
const NOW_RANK = { building: 0, review: 1, landing: 2 };
const nowLine = (roll) => {
  if (!roll.inFlight.length) return `<div class="nowline"><span class="lbl">now:</span> <span class="none">—</span></div>`;
  const parts = [...roll.inFlight].sort((a, b) => (NOW_RANK[a.state] - NOW_RANK[b.state]) || (+a.num - +b.num))
    .map((x) => `#${esc(x.num)} ${NOW_WORD[x.state]}`).join(' · ');
  return `<div class="nowline"><span class="lbl">now:</span> ${parts}</div>`;
};

const CHIP = { ok: 'ok', review: 'review', gate: 'gate', build: 'build', held: 'held', needs: 'needs', ready: 'ready' };
const STATE_LABEL = { 'needs-slice': 'needs /slice' };
const chip = (it) => `<span class="chip ${CHIP[it.cls]} sm">${esc(STATE_LABEL[it.state] || it.state)}</span>`;
// per-epic guidance appended to the title cell: what to actually do with this epic.
const epicNote = (it) => {
  if (it.state === 'needs-slice') return ` <span class="epic-todo">— unsliced · <b>/slice ${esc(it.num)}</b> · ${esc(it.sliceHint || 'slice into buildable stories')}</span>`;
  if (it.state === 'epic') return ` <span class="epic-wait">— umbrella · <b>${it.kids.open}/${it.kids.total}</b> stories open · no action, resolves when they land</span>`;
  return '';
};

const groupsOrder = ['#2612 · Conveyor skill', '#2677 · Mechanize core', 'Jury · review-to-convergence', 'Program & health', 'Drain / lander / review-gate', 'Other'];
const rowsFor = (bk) => remainingItems.filter((i) => i.bucket === bk).sort((a, b) => +a.num - +b.num)
  .map((it) => `<tr><td class="id">#${esc(it.num)}</td><td class="sz">${esc(it.size || '—')}</td><td>${chip(it)}</td><td class="desc">${esc(it.title)}${epicNote(it)}</td></tr>`).join('\n');

const stamp = `${today} · live @ ${new Date().toISOString().slice(11, 16)}Z`;

// ---- lane pool ----
const poolLanes = (() => { const a = j('node scripts/lane-pool.mjs status --json --max-age-ms=60000'); return Array.isArray(a) ? a : (a && a.lanes) || []; })();
const busyCount = poolLanes.filter((l) => l.leased).length;
let ghostLaneCount = 0;
const laneChips = [...poolLanes].sort((a, b) => (a.lane || 0) - (b.lane || 0)).map((l) => {
  const sess = (l.lease && l.lease.session) || '';
  const numMatch = sess.match(/(\d{3,5})/);
  const ghost = l.leased && numMatch && (mergedToday.includes(numMatch[1]) || prByNum[numMatch[1]]);
  if (ghost) ghostLaneCount++;
  const short = sess.replace(/^(conveyor-|prepare-decision-|prepare-|fix-|rescope-|resolve-|ratify-)/, '');
  const cls = !l.leased ? 'free' : ghost ? 'ghost' : 'busy';
  const title = esc(sess) + (ghost ? ' — item already merged/PR-open (ghost lease, reaping)' : '');
  return `<span class="lane-chip ${cls}" title="${title}">L${esc(l.lane)}${l.leased && short ? ' · ' + esc(short.slice(0, 18)) : ''}${ghost ? ' ⚠' : ''}</span>`;
}).join('');

// ---- emit ----
const CSS = `<style>
  :root {
    --bg: #f4f5f7; --panel: #ffffff; --panel-2: #fafbfc;
    --ink: #1a1d24; --ink-2: #545b68; --ink-3: #8b94a3;
    --line: #e2e6ec; --line-2: #eef1f5;
    --accent: #b5701f; --accent-soft: #f5e6d2;
    --ok: #2f8f63; --ok-soft: #e2f2ea;
    --review: #b5851f; --review-soft: #f6ecd2;
    --gate: #7a5fca; --gate-soft: #ece7f9;
    --build: #2f77b5; --build-soft: #e0edf7;
    --held: #7b8494; --held-soft: #edf0f4;
    --alert: #c0552f; --alert-soft: #f8e4dc;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --shadow: 0 1px 2px rgba(20,25,35,.05), 0 4px 16px rgba(20,25,35,.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116; --panel: #161b22; --panel-2: #1b2129;
      --ink: #e7ebf1; --ink-2: #a3adbd; --ink-3: #6b7686;
      --line: #262d38; --line-2: #1f262f;
      --accent: #d99a52; --accent-soft: #2e2416;
      --ok: #46b183; --ok-soft: #10251c;
      --review: #d4ab52; --review-soft: #2a2312;
      --gate: #a68ce6; --gate-soft: #201a30;
      --build: #5aa0d9; --build-soft: #101f2c;
      --held: #8791a1; --held-soft: #1a1f27;
      --alert: #e0764f; --alert-soft: #2c150e;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 4px 20px rgba(0,0,0,.25);
    }
  }
  :root[data-theme="light"] {
    --bg: #f4f5f7; --panel: #ffffff; --panel-2: #fafbfc;
    --ink: #1a1d24; --ink-2: #545b68; --ink-3: #8b94a3;
    --line: #e2e6ec; --line-2: #eef1f5;
    --accent: #b5701f; --accent-soft: #f5e6d2;
    --ok: #2f8f63; --ok-soft: #e2f2ea; --review: #b5851f; --review-soft: #f6ecd2;
    --gate: #7a5fca; --gate-soft: #ece7f9; --build: #2f77b5; --build-soft: #e0edf7;
    --held: #7b8494; --held-soft: #edf0f4; --alert: #c0552f; --alert-soft: #f8e4dc;
  }
  :root[data-theme="dark"] {
    --bg: #0e1116; --panel: #161b22; --panel-2: #1b2129;
    --ink: #e7ebf1; --ink-2: #a3adbd; --ink-3: #6b7686;
    --line: #262d38; --line-2: #1f262f;
    --accent: #d99a52; --accent-soft: #2e2416;
    --ok: #46b183; --ok-soft: #10251c; --review: #d4ab52; --review-soft: #2a2312;
    --gate: #a68ce6; --gate-soft: #201a30; --build: #5aa0d9; --build-soft: #101f2c;
    --held: #8791a1; --held-soft: #1a1f27; --alert: #e0764f; --alert-soft: #2c150e;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); line-height: 1.5; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 64px; }
  header.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 6px; }
  .title { font-size: 26px; font-weight: 680; letter-spacing: -.02em; margin: 0; }
  .belt { color: var(--accent); }
  .stamp { font-family: var(--mono); font-size: 12.5px; color: var(--ink-3); }
  .mono2 { font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); }
  .sub { color: var(--ink-2); font-size: 14.5px; margin: 4px 0 28px; max-width: 64ch; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 16px 14px; box-shadow: var(--shadow); }
  .kpi .n { font-size: 30px; font-weight: 700; letter-spacing: -.03em; font-variant-numeric: tabular-nums; line-height: 1; }
  .kpi .l { font-size: 12px; color: var(--ink-2); margin-top: 8px; text-transform: uppercase; letter-spacing: .05em; }
  .kpi.attn .n { color: var(--alert); } .kpi.ok .n { color: var(--ok); } .kpi.review .n { color: var(--review); } .kpi.build .n { color: var(--build); }
  .flow { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-bottom: 24px; box-shadow: var(--shadow); }
  .stage { padding: 14px 16px; border-right: 1px solid var(--line-2); }
  .stage:last-child { border-right: none; }
  .stage .h { font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .stage .items { display: flex; flex-wrap: wrap; gap: 5px; }
  section { margin: 30px 0; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-2); margin: 0 0 12px; font-weight: 640; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
  .chip.ok { background: var(--ok-soft); color: var(--ok); }
  .chip.review { background: var(--review-soft); color: var(--review); }
  .chip.gate { background: var(--gate-soft); color: var(--gate); }
  .chip.build { background: var(--build-soft); color: var(--build); }
  .chip.held { background: var(--held-soft); color: var(--held); }
  .chip.needs { background: var(--alert-soft); color: var(--alert); }
  .chip.ready { background: var(--build-soft); color: var(--build); }
  .chip.sm { font-size: 11px; padding: 1px 7px; }
  .grouplbl { font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); font-weight: 640; margin: 22px 0 8px; padding-left: 2px; }
  .lanes-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .lane-chip { font-family: var(--mono); font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 7px; white-space: nowrap; border: 1px solid var(--line); }
  .lane-chip.busy { background: var(--build-soft); color: var(--build); border-color: color-mix(in srgb, var(--build) 30%, transparent); }
  .lane-chip.free { background: var(--panel-2); color: var(--ink-3); }
  .lane-chip.ghost { background: var(--alert-soft); color: var(--alert); border-color: color-mix(in srgb, var(--alert) 35%, transparent); border-style: dashed; }
  .h2sub { font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--ink-3); font-size: 12px; margin-left: 6px; }
  .epic-list { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 2px; }
  .epic-row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 8px; font-size: 13px; }
  .epic-row.todo { background: var(--needs-soft, var(--alert-soft)); }
  .epic-row.wait { background: var(--panel-2); }
  .epic-row .epic-t { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .epic-row.todo .epic-t { color: var(--ink); }
  .epic-todo { color: var(--alert); font-size: 12.5px; }
  .epic-wait { color: var(--ink-3); font-size: 12.5px; }
  .epic-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 12px 16px; margin-bottom: 10px; }
  .epic-hd { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .epic-hd .en { font-family: var(--mono); font-weight: 600; white-space: nowrap; }
  .epic-hd .et { color: var(--ink); font-weight: 560; }
  .rollup { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 9px 0 2px; }
  .rpill { font-family: var(--mono); font-size: 11.5px; padding: 2px 8px; border-radius: 20px; background: var(--panel-2); border: 1px solid var(--line); color: var(--ink-2); white-space: nowrap; }
  .rpill b { color: var(--ink); font-weight: 700; }
  .rpill.total { background: transparent; border-color: transparent; color: var(--ink-3); padding-left: 0; }
  .rpill.ok b { color: var(--ok); } .rpill.build b { color: var(--build); } .rpill.review b { color: var(--review); }
  .rpill.ready b { color: var(--build); } .rpill.needs b { color: var(--alert); } .rpill.held b { color: var(--held); }
  .nowline { font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); margin-top: 7px; }
  .nowline .lbl, .nowline .none { color: var(--ink-3); }
  .tallies { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .tally { font-family: var(--mono); font-size: 12px; padding: 6px 11px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); color: var(--ink-2); }
  .tally b { color: var(--ink); }
  .twrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-3); font-weight: 600; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  td { padding: 10px 14px; border-bottom: 1px solid var(--line-2); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  td.id { font-family: var(--mono); font-weight: 600; white-space: nowrap; }
  td.sz { font-family: var(--mono); color: var(--ink-3); text-align: center; }
  .desc { color: var(--ink-2); }
  .win { display: inline-flex; align-items: center; gap: 8px; background: var(--ok-soft); color: var(--ok); font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 10px; font-family: var(--mono); margin-bottom: 4px; max-width: 100%; overflow-x: auto; }
  .note { font-size: 12.5px; color: var(--ink-3); margin-top: 8px; }
  footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-3); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 720px) { .kpis { grid-template-columns: repeat(2, 1fr); } .flow { grid-template-columns: 1fr 1fr; } .stage:nth-child(2) { border-right: none; } }
</style>`;

process.stdout.write(`<title>Conveyor Status</title>
${CSS}
<div class="wrap">
  <header class="top">
    <h1 class="title">Conveyor <span class="belt">▸</span> delivery status</h1>
    <span class="stamp">${esc(stamp)} · auto-generated</span>
  </header>
  <p class="sub">Live snapshot from <span class="mono2">conveyor-state</span> + <span class="mono2">dispatch-plan</span> + the backlog scan. The drain daemon lands PRs — the conveyor never merges. Regenerated from state each refresh.</p>

  <div class="kpis">
    <div class="kpi ok"><div class="n">${mergedToday.length}</div><div class="l">Merged today</div></div>
    <div class="kpi build"><div class="n">${buildingItems.length}</div><div class="l">Building</div></div>
    <div class="kpi review"><div class="n">${inReviewItems.length}</div><div class="l">In review</div></div>
    <div class="kpi review"><div class="n">${landingItems.length}</div><div class="l">Landing · awaiting drain</div></div>
  </div>

  <div class="flow">
    <div class="stage"><div class="h"><span class="dot" style="background:var(--build)"></span>Ready · ${readyItems.length}</div><div class="items">${readyItems.slice(0, 8).map((n) => `<span class="chip ready sm">#${n}</span>`).join('')}${readyItems.length > 8 ? `<span class="chip ready sm">+${readyItems.length - 8}</span>` : ''}</div></div>
    <div class="stage"><div class="h"><span class="dot" style="background:var(--review)"></span>In review · ${inReviewItems.length}</div><div class="items">${inReviewItems.map((it) => `<span class="chip review sm">#${it.num}</span>`).join('') || '<span class="chip held sm">—</span>'}</div></div>
    <div class="stage"><div class="h"><span class="dot" style="background:var(--ok)"></span>Landing · ${landingItems.length}</div><div class="items">${landingItems.map((it) => `<span class="chip ok sm">#${it.num}</span>`).join('') || '<span class="chip held sm">—</span>'}</div></div>
    <div class="stage"><div class="h"><span class="dot" style="background:var(--gate)"></span>Needs you · ${humanReviewItems.length + gateItems.length}</div><div class="items">${[...humanReviewItems, ...gateItems].map((it) => `<span class="chip gate sm">#${it.num}</span>`).join('') || '<span class="chip held sm">none</span>'}</div></div>
  </div>

  <div class="win">✓ merged today: ${mergedToday.sort((a, b) => +a - +b).map((n) => '#' + n).join(' ') || '—'}</div>

  <section>
    <h2>Lane pool · ${busyCount}/${poolLanes.length} leased</h2>
    <div class="card" style="padding:14px 16px"><div class="lanes-grid">${laneChips || '<span class="note">no lane data</span>'}</div></div>
    <p class="note">Live lease occupancy. Aggressive parallelism keeps most lanes leased; free lanes recycle as scope/delivery PRs land.${ghostLaneCount ? ` <b>${ghostLaneCount}</b> <span class="lane-chip ghost" style="padding:0 5px">⚠ ghost</span> lease(s) — the item already merged / has an open PR, so the lane is a stale straggler being reaped (a stale re-dispatch, not active work).` : ' No ghost leases.'}</p>
  </section>

  <section>
    <h2>Epics — progress <span class="h2sub">${openEpics.length} open · child-state rollup</span></h2>
    ${openEpics.length ? openEpics.map(({ it, roll }) => {
      const unsliced = it.state === 'needs-slice';
      const hd = `<div class="epic-hd"><span class="en">#${esc(it.num)}</span><span class="et">${esc(it.title)}</span>${unsliced ? '<span class="chip needs sm">needs /slice</span>' : '<span class="chip held sm">epic</span>'}</div>`;
      if (unsliced) return `<div class="epic-card">${hd}<p class="note" style="margin:7px 0 0">unsliced · <b>/slice ${esc(it.num)}</b> · ${esc(it.sliceHint || 'slice into buildable stories')}</p></div>`;
      return `<div class="epic-card">${hd}<div class="rollup">${rollupPills(roll)}</div>${nowLine(roll)}</div>`;
    }).join('\n') : '<div class="card" style="padding:14px 16px"><span class="note">no open epics</span></div>'}
    <p class="note">Each storied epic resolves only when every child lands. <span class="mono2">now:</span> names the children moving right now (building · review · landing); unsliced epics need a <b>/slice</b> before any child exists.</p>
  </section>

  <section>
    <h2>Remaining backlog · ${remainingItems.length} items</h2>
    <p class="note" style="margin:-4px 0 14px">Excludes merged items (listed separately below). <span class="chip ready sm">ready</span> scoped &amp; dispatchable · <span class="chip build sm">building</span> · <span class="chip review sm">in-review</span> · <span class="chip ok sm">landing</span> · <span class="chip held sm">blocked</span> · <span class="chip needs sm">needs-scope</span> · <span class="chip gate sm">decision/gate</span>.</p>
    ${groupsOrder.filter((bk) => remainingItems.some((i) => i.bucket === bk)).map((bk) => `
    <div class="grouplbl">${esc(bk)} · ${remainingItems.filter((i) => i.bucket === bk).length}</div>
    <div class="card twrap"><table><thead><tr><th>Item</th><th>Sz</th><th>State</th><th>Title</th></tr></thead><tbody>
    ${rowsFor(bk)}
    </tbody></table></div>`).join('\n')}

    <div class="tallies">
      <span class="tally"><b>${remainingItems.length}</b> remaining</span>
      <span class="tally"><b>${readyItems.length}</b> ready now</span>
      <span class="tally"><b>${needsScope}</b> needs-scope</span>
      <span class="tally"><b>${gateItems.length}</b> your decisions</span>
    </div>
    <p class="note">Scoping is the gating activity — needs-scope items are invisible to the dispatch plan until a scope-lease is authored.</p>
  </section>

  <section>
    <h2>Merged today · ${mergedToday.length}</h2>
    <div class="card" style="padding:14px 16px">
      <div class="lanes-grid">${mergedToday.sort((a, b) => +a - +b).map((n) => `<span class="chip ok sm">#${n}</span>`).join('') || '<span class="note">none yet</span>'}</div>
      ${mergedListItems.length ? `<p class="note"><b>${mergedListItems.length}</b> of these still carry an open card (resolve-on-land straggler — the work landed, only the status flip is pending): ${mergedListItems.map((it) => '#' + it.num).join(' ')}</p>` : ''}
    </div>
  </section>

  <footer>
    <span>Conveyor operator · auto-generated from live state</span>
    <span>drain lands · conveyor never merges · edits via lane clones</span>
  </footer>
</div>
`);
