/**
 * @file decision-docket-render.mjs — the TEMPLATE half of the Decision Docket's data/template separation
 * (see decision-docket-data.mjs's header for the full "why" — the meta-commentary problem this pair fixes).
 *
 * `renderDocketHtml(data, templateHtml)` is a PURE function: the same `data` JSON and the same
 * `skills-src/decision-docket/template.html` content always produce byte-identical HTML. There is no code
 * path here that accepts free-text narrative ("correction", "second pass", "false alarm") — the render
 * function only knows how to turn the data schema's fields into markup, so there is nowhere to hand-inject
 * session commentary without editing THIS file (which would then apply to every future render, not just one
 * page — exactly the discipline a real template is supposed to enforce). Any note about how the data changed
 * belongs in `git log` on the JSON data file this reads, never in the rendered output.
 *
 * Reuses `template.html`'s own CSS/token palette VERBATIM (sliced out of the real file at render time) rather
 * than re-declaring it here, so the two can never drift into two different visual languages — the exact
 * failure `skills-src/decision-docket/SKILL.md` documents happened to the last two hand-built revisions.
 */

import { renderMarkdown, renderMarkdownBlocks, renderMarkdownInline } from './decision-docket-markdown.mjs';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Inline markdown → HTML for one-line fields (titles, fork cruxes, the footer's own strings). Thin alias over
 * the shared renderer — see `decision-docket-markdown.mjs` for the rules (real markdown-it grammar, HTML in the
 * source escaped, relative links reduced to their visible text). Kept as a named export for existing callers.
 * @param {string} s
 * @returns {string}
 */
export function mdInline(s) {
  return renderMarkdownInline(s);
}

/**
 * A text field that may hold block markdown, placed in its own styled container: a lone plain paragraph keeps
 * the container as `<p class="…">` (byte-for-byte the old markup); anything with a list, blockquote, code fence,
 * heading, table or several paragraphs becomes `<div class="…">` — block HTML is never nested inside a `<p>`.
 * @param {string} src
 * @param {string} cls
 * @returns {string}
 */
function mdContainer(src, cls) {
  const { html, flow } = renderMarkdown(src);
  if (!html.trim()) return '';
  return flow ? `<div class="${cls}">${html}</div>` : `<p class="${cls}">${html}</p>`;
}

/**
 * A generator-authored warning message, as HTML. It is plain text, not markdown — but it quotes markdown
 * SYNTAX as literal samples ("- **(a)** …", "## Fork N"). Those double-quoted spans are shown as code, so the
 * markers read as a sample of the syntax being described rather than as broken formatting; everything else is
 * escaped verbatim.
 * @param {string} text
 * @returns {string}
 */
function renderWarning(text) {
  return escapeHtml(text).replace(/&quot;([^&]*?)&quot;/g, '<code>$1</code>');
}

/** Age → the docket's three-way bucket + row class, mirroring the past docket's own convention. */
export function ageClass(days) {
  if (days > 60) return 'stale';
  if (days > 30) return 'waiting';
  return 'fresh';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function humanDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Slice `template.html`'s own head+style shell (everything before `<div class="wrap">`) out verbatim, EXCEPT
 * for its own `<!-- -->` HTML comments — template.html carries a large instructional comment aimed at whoever
 * edits the template next (never at whoever views the rendered page), and it must never reach the generated
 * output. A well-formed HTML comment renders as nothing in a spec-compliant browser regardless of position, so
 * this isn't the ONLY thing standing between that comment and a viewer — but this generator has exactly one
 * legitimate reason to touch the raw file text at all (author-facing template comments), so it strips every
 * comment here unconditionally rather than relying on some downstream consumer's parsing quirks to keep them
 * inert. Non-greedy so multiple separate comments in the shell are each stripped individually, not merged into
 * one span from the first `<!--` to the last `-->`.
 */
function extractShell(templateHtml) {
  const marker = '<div class="wrap">';
  const idx = templateHtml.indexOf(marker);
  if (idx === -1) throw new Error('decision-docket template.html: could not find the <div class="wrap"> marker — has the template shape changed?');
  return templateHtml.slice(0, idx).replace(/<!--[\s\S]*?-->/g, '');
}

function renderOption(opt) {
  const cls = opt.kind === 'default' ? 'oc' : opt.kind === 'rejected' ? 'ov' : 'oo';
  const mark = opt.kind === 'default' ? '✓ Default' : opt.kind === 'rejected' ? '✕ Rejected' : '○ Option';
  return `<div class="opt ${cls}">
            <div class="opt-lbl">${mark} — ${escapeHtml(opt.label)}</div>
            <div class="opt-bd">${renderMarkdown(opt.body).html}</div>
          </div>`;
}

function optsWidthClass(count) {
  if (count <= 1) return ' one';
  if (count === 3) return ' three';
  return '';
}

function renderNote(note) {
  if (note.kind === 'code') return `<pre><code>${escapeHtml(note.text)}</code></pre>`;
  return renderMarkdownBlocks(note.text).trim();
}

/**
 * The closing Skeptic/Screen verdict line. Both parts are usually one plain paragraph each (kept as the single
 * mono `<p class="attack …">` line); if either holds block markdown (a list, a code fence) the line becomes a
 * `<div>` with each verdict in its own block instead.
 */
function renderVerdicts(fork, attackClass) {
  const parts = [];
  if (fork.skeptic) parts.push({ label: 'Skeptic', ...renderMarkdown(fork.skeptic) });
  if (fork.screen) parts.push({ label: 'Screen', ...renderMarkdown(fork.screen) });
  if (!parts.some((p) => p.flow)) {
    return `<p class="attack ${attackClass}">${parts.map((p) => `<b>${p.label}:</b> ${p.html}`).join(' &nbsp;·&nbsp; ')}</p>`;
  }
  return `<div class="attack ${attackClass}">${parts.map((p) => (p.flow
    ? `<div><b>${p.label}:</b></div>${p.html}`
    : `<div><b>${p.label}:</b> ${p.html}</div>`)).join('')}</div>`;
}

/**
 * The verdict CLASS of a fork's or gate's `{ skeptic, screen }` pair, read off the START of the Skeptic/Screen
 * text (the actual vocabulary — REFUTED / SURVIVES[-WITH-AMENDMENT] for Skeptic, clear / flagged(impl|prio) for
 * Screen — docs/agent/backlog-workflow.md's "two-confusion screen"), never a substring search: the prose ITSELF
 * routinely uses the word "flagged" in an unrelated sense ("the attack also flagged X as under-specified"),
 * which a substring match would misread as the verdict.
 */
function attackClassFor({ skeptic, screen }) {
  if (/^flagged/i.test((screen || '').trim())) return 'flagged';
  if (/^REFUTED/i.test((skeptic || '').trim())) return 'refuted';
  return 'clear';
}

/**
 * A prepared validation-gate decision (a one-sided go / no / not-yet call — no `## Fork N`, so no options to
 * list): what is being decided, the prior-art delta when the item carries one, then the recommended verdict +
 * un-gate trigger as the single default card, closed by the same Skeptic/Screen line a fork gets. A gate whose
 * body didn't parse shows only its heading and a referral, exactly as a parse-incomplete fork does.
 */
function renderGate(gate) {
  const head = '<div class="forkhd"><span class="forktag">GATE</span> A one-sided go / no-go call — no rival branch to weigh</div>';
  if (!gate.parseOk) {
    return `
        ${head}
        <p class="attack flagged"><b>Parse incomplete:</b> ${renderWarning(gate.warning || 'this gate did not match the documented validation-gate shape.')} Read this gate directly in the item's own file — the extracted text is not shown here rather than risk a garbled or misleading render.</p>`;
  }
  const deciding = gate.deciding ? mdContainer(gate.deciding, 'forkwhy') : '';
  const priorArt = gate.priorArt ? `<div class="forkwhy"><p><b>Prior-art delta.</b></p>${renderMarkdownBlocks(gate.priorArt).trim()}</div>` : '';
  const verdictCard = gate.recommendation
    ? `<div class="opts one">
          <div class="opt oc">
            <div class="opt-lbl">✓ Recommended verdict</div>
            <div class="opt-bd">${renderMarkdown(gate.recommendation).html}</div>
          </div>
        </div>`
    : '';
  const skepticScreen = (gate.skeptic || gate.screen) ? renderVerdicts(gate, attackClassFor(gate)) : '';
  return `
        ${head}
        ${deciding}
        ${priorArt}
        ${verdictCard}
        ${skepticScreen}`;
}

function renderFork(fork) {
  // A fork whose body doesn't match the documented prepared-fork shape (docs/agent/backlog-workflow.md
  // #decision-docket) most often predates that convention — it uses a different, more free-form markdown
  // dialect (bracket markers like "[bold default]" instead of "← **RECOMMENDED**", sub-bullets nested INSIDE
  // one option's own body, unclosed ** pairs). Attempting to render that prose through the same fixed inline
  // rules the canonical shape earns produces genuinely garbled output — stray literal "**", flattened
  // sub-bullets running on as unpunctuated dash-separated fragments — which is worse than showing nothing:
  // a decider could misread a mangled fragment as the item's actual position. So a parse-incomplete fork
  // shows ONLY its heading + a clear referral to the source file, never a best-effort (and possibly
  // misleading) rendering of content this renderer could not confidently structure.
  if (!fork.parseOk) {
    return `
        <div class="forkhd"><span class="forktag">FORK ${fork.n}</span> ${mdInline(fork.crux || '')}</div>
        <p class="attack flagged"><b>Parse incomplete:</b> ${renderWarning(fork.warning || 'this fork did not match the documented prepared-fork shape.')} Read this fork directly in the item's own file — the extracted text is not shown here rather than risk a garbled or misleading render.</p>`;
  }

  const optsHtml = fork.options.map(renderOption).join('\n          ');
  const notesHtml = fork.notes.map(renderNote).join('\n        ');
  // The verdict CLASS is read off the START of the Skeptic/Screen text (the actual vocabulary — REFUTED /
  // SURVIVES[-WITH-AMENDMENT] for Skeptic, clear / flagged(impl|prio) for Screen — docs/agent/backlog-
  // workflow.md's "two-confusion screen"), never a substring search: the prose ITSELF routinely uses the word
  // "flagged" in an unrelated sense ("the attack also flagged X as under-specified"), which a substring match
  // would misread as the verdict.
  const skepticScreen = (fork.skeptic || fork.screen) ? renderVerdicts(fork, attackClassFor(fork)) : '';
  return `
        <div class="forkhd"><span class="forktag">FORK ${fork.n}</span> ${mdInline(fork.crux || '')}</div>
        ${fork.why ? mdContainer(fork.why, 'forkwhy') : ''}
        <div class="opts${optsWidthClass(fork.options.length)}">
          ${optsHtml}
        </div>
        ${notesHtml}
        ${skepticScreen}`;
}

function renderDoneWhen(doneWhen) {
  if (!doneWhen.length) return 'See the item\'s own <code>## Acceptance</code> section.';
  return renderMarkdownBlocks(doneWhen[0]).trim();
}

/** The item's id, safe to use as an HTML `id`/fragment target (`#item-<num>`) — nums are plain digits today,
 * but escape defensively rather than assume that never changes. */
function anchorId(item) {
  return `item-${escapeHtml(item.num)}`;
}

function renderCard(item) {
  const forksHtml = item.gate ? renderGate(item.gate) : item.forks.map(renderFork).join('\n');
  const digestHtml = item.digest.length
    ? item.digest.map((p) => renderMarkdownBlocks(p).trim()).join('\n        ')
    : '<p><em>No digest paragraph could be extracted from this item\'s body.</em></p>';
  const topWarning = item.parseOk
    ? ''
    : `<p><strong>Parse incomplete</strong> — ${renderWarning((item.warnings || []).join(' ') || 'this item\'s forks did not match the documented prepared-fork shape.')} Ratify from <code>backlog/${escapeHtml(item.num)}-*.md</code> directly until this is fixed.</p>`;
  // Every card here IS a prepared item with full fork detail by construction (only `prepared` items reach
  // `renderCard` at all — see renderDocketHtml below), so `data-detail` is fixed; `data-status` is `review` for a
  // decision with an open PR, else `ready`; the age bucket varies per item. These mirror the summary table's own filter attributes so the SAME toolbar filters
  // both the ranking table and this full-detail section together.
  const review = item.pr ? ` · ${escapeHtml(prLabel(item.pr))} in review` : '';
  return `
    <div class="dcard" id="${anchorId(item)}" data-status="${item.pr ? 'review' : 'ready'}" data-detail="full" data-age="${ageClass(item.ageInDays)}">
      <div class="hd">
        <span class="num">#${escapeHtml(item.num)}</span><span class="nm">${mdInline(item.title)}</span>
        <span class="meta">prepared ${escapeHtml(item.preparedDate || '—')} · unblocks ${item.directUnblocks} · waiting ${item.ageInDays}d${review}</span>
      </div>
      <div class="bd">
        ${digestHtml}
        ${topWarning}
        ${forksHtml}
      </div>
      <div class="thecall"><span>Once ratified</span>${renderDoneWhen(item.doneWhen)}</div>
    </div>`;
}

function renderTableRow(item) {
  const cls = ageClass(item.ageInDays);
  const pill = item.prepared
    ? '<span class="pill prepd">prepared</span>'
    : '<span class="pill warnp">needs prep</span>';
  const agePct = Math.min(100, Math.round((item.ageInDays / 90) * 100));
  // Only a PREPARED item has a `.dcard` further down the page to jump to — an un-prepared item's row stays
  // plain text rather than link to a fragment that doesn't exist.
  const titleHtml = item.prepared
    ? `<a href="#${anchorId(item)}">${mdInline(item.title)}</a>`
    : mdInline(item.title);
  return `      <tr class="${cls}" data-status="${item.prepared ? 'ready' : 'prep'}" data-detail="${item.prepared ? 'full' : 'table'}" data-age="${cls}">
        <td class="n mono">#${escapeHtml(item.num)}</td>
        <td class="ti">${titleHtml} ${pill}</td>
        <td class="n mono">${item.directUnblocks}</td>
        <td class="n mono">${item.unblocksToReady}</td>
        <td class="agec"><span class="bar"><i style="width:${agePct}%"></i></span><span class="mono age">${item.ageInDays}d</span></td>
      </tr>`;
}

/** A PR link only ever points at http(s): the url comes from `gh`, but the data file is plain JSON on disk. */
function safeHref(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}

/** "PR #2376" for a web-everything PR, "frontierui PR #12" for a sibling repo's (the number alone is ambiguous). */
function prLabel(pr) {
  const repoName = pr.repo && !/(^|\/)web-everything$/.test(pr.repo) ? `${pr.repo.split('/').pop()} ` : '';
  return pr.number == null ? `${repoName}open PR` : `${repoName}PR #${pr.number}`;
}

const PR_KIND_LABEL = { ratification: 'ratification', preparation: 'preparation', other: 'other PR' };
const PR_KIND_ORDER = { ratification: 0, preparation: 1, other: 2 };
// One line each — what the open PR means for the decision, in plain words. Derived from `pr.kind` alone, so the
// same data always renders the same sentence (no free text from the PR body reaches the page).
const PR_STATE_LINE = {
  ratification: 'Ratification proposed; merging the PR rules this decision.',
  preparation: 'Preparation in review; its forks land when the PR merges.',
  other: 'An open PR touches this decision.',
};

function renderReviewRow(item) {
  const cls = ageClass(item.ageInDays);
  const pr = item.pr;
  const pill = item.prepared
    ? '<span class="pill prepd">prepared</span>'
    : '<span class="pill warnp">needs prep</span>';
  const agePct = Math.min(100, Math.round((item.ageInDays / 90) * 100));
  const href = safeHref(pr.url);
  const label = escapeHtml(prLabel(pr));
  const link = href ? `<a href="${escapeHtml(href)}" title="${escapeHtml(pr.title)}">${label}</a>` : label;
  const blocked = (item.blockedBy || []).length ? ` Blocked by ${item.blockedBy.map((n) => `#${escapeHtml(n)}`).join(', ')}.` : '';
  const kind = PR_KIND_LABEL[pr.kind] ?? PR_KIND_LABEL.other;
  // A prepared in-review decision keeps its full `.dcard` in the prepared section (the docket's hard rule: every
  // prepared item it lists shows its fork breakdown), so its title jumps there; an un-prepared one has no card.
  const titleHtml = item.prepared
    ? `<a href="#${anchorId(item)}">${mdInline(item.title)}</a>`
    : mdInline(item.title);
  return `      <tr class="${cls}" data-status="review" data-detail="table" data-age="${cls}">
        <td class="n mono">#${escapeHtml(item.num)}</td>
        <td class="ti">${titleHtml} ${pill}</td>
        <td class="mono">${link}</td>
        <td><span class="pill batchp">${escapeHtml(kind)}</span> ${escapeHtml(PR_STATE_LINE[pr.kind] ?? PR_STATE_LINE.other)}${blocked}</td>
        <td class="n mono">${item.directUnblocks}</td>
        <td class="agec"><span class="bar"><i style="width:${agePct}%"></i></span><span class="mono age">${item.ageInDays}d</span></td>
      </tr>`;
}

/** The "In review: a PR is open" section — listed first so a ratification awaiting review is the first thing seen. */
function renderReviewSection(reviewItems) {
  const rows = reviewItems.map(renderReviewRow).join('\n');
  return `<section id="in-review">
  <h2>Open decisions with a pull request</h2>
  <h3>In review: a PR is open</h3>
  <p>Each decision here already has an open pull request &mdash; a ratification or a preparation waiting on review. They are listed in this section rather than in the ranked tables below, so nothing is hidden while its PR is open. A decision that is also blocked by another item is listed here too, with what blocks it.</p>
  <div class="tw"><table>
    <thead><tr><th>ID</th><th class="ti">Decision</th><th>Pull request</th><th>State</th><th class="n">Unblocks</th><th>Waiting</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
</section>

`;
}

/**
 * Render the full Decision Docket page from the clean data JSON and the real `template.html` content. PURE:
 * no fs, no clock reads unless `now` is supplied — the same inputs always produce the same output.
 * @param {{ items: object[], counts?: object, generatedAt?: string, generatedFromRef?: string, targetCount?: number }} data
 * @param {string} templateHtml - the raw content of `skills-src/decision-docket/template.html`.
 * @param {{ now?: Date }} [opts]
 * @returns {string}
 */
export function renderDocketHtml(data, templateHtml, { now = new Date() } = {}) {
  const all = Array.isArray(data.items) ? [...data.items] : [];
  all.sort((a, b) => (b.leverageScore ?? 0) - (a.leverageScore ?? 0));
  // A decision with an open PR is listed in its own "In review" section (ratifications first, then preparations,
  // then any other PR; leverage order within a kind — `sort` is stable). Everything below is the rest of the docket.
  const reviewItems = all.filter((i) => i.pr)
    .sort((a, b) => (PR_KIND_ORDER[a.pr.kind] ?? 2) - (PR_KIND_ORDER[b.pr.kind] ?? 2));
  const items = all.filter((i) => !i.pr);

  const prepared = items.filter((i) => i.prepared);
  const needsPrep = items.filter((i) => !i.prepared);
  const stale = items.filter((i) => i.ageInDays > 60);

  const shell = extractShell(templateHtml);
  const kicker = `Session docket · web-everything · ${humanDate(now)}`;

  const rows = items.map(renderTableRow).join('\n');
  // Every PREPARED decision gets its card, in-review ones included (see renderReviewRow); ranked order.
  const cards = all.filter((i) => i.prepared).map(renderCard).join('\n');
  const upstreamRows = needsPrep.map(renderTableRow).join('\n');

  const reviewSection = reviewItems.length ? renderReviewSection(reviewItems) : '';
  const lede = reviewItems.length
    ? `<b>${all.length} are open: ${reviewItems.length} ${reviewItems.length === 1 ? 'has' : 'have'} a pull request open, ${prepared.length} more ${prepared.length === 1 ? 'is' : 'are'} prepared and awaiting ratification, and ${needsPrep.length} need${needsPrep.length === 1 ? 's' : ''} preparation.</b>`
    : `<b>${prepared.length} are prepared and awaiting ratification.</b>`;
  const reviewStat = reviewItems.length
    ? `\n    <div class="stat r"><div class="v">${reviewItems.length}</div><div class="k">In review &mdash; PR open</div></div>`
    : '';
  const reviewFilter = reviewItems.length
    ? '\n    <button type="button" class="fbtn" data-group="status" data-value="review">In review</button>'
    : '';

  const provenance = [
    `Generated ${now.toISOString()}`,
    data.generatedFromRef ? `from ${escapeHtml(data.generatedFromRef)}` : null,
    `by scripts/gen-decision-docket.mjs (backlog/3562's data/template separation) — regenerate with`,
  ].filter(Boolean).join(' ');

  return `${shell}<div class="wrap">

<header class="mast">
  <p class="kicker">${escapeHtml(kicker)}</p>
  <h1>Decision Docket</h1>
  <p class="lede">Every open decision on the board, ranked by what it unblocks and how long it has waited. ${lede}</p>
  <div class="stats">${reviewStat}
    <div class="stat a"><div class="v">${prepared.length}</div><div class="k">Ready to ratify</div></div>
    <div class="stat"><div class="v">${needsPrep.length}</div><div class="k">Need preparation</div></div>
    <div class="stat s"><div class="v">${stale.length}</div><div class="k">Waiting 61+ days</div></div>
  </div>
</header>

<div class="filters" role="group" aria-label="Filter the docket">
  <div class="filtergroup">
    <span class="flabel">Status</span>
    <button type="button" class="fbtn active" data-group="status" data-value="all">All</button>${reviewFilter}
    <button type="button" class="fbtn" data-group="status" data-value="ready">Ready to ratify</button>
    <button type="button" class="fbtn" data-group="status" data-value="prep">Needs prep</button>
  </div>
  <div class="filtergroup">
    <span class="flabel">Age</span>
    <button type="button" class="fbtn active" data-group="age" data-value="all">All</button>
    <button type="button" class="fbtn" data-group="age" data-value="fresh">Fresh ≤30d</button>
    <button type="button" class="fbtn" data-group="age" data-value="waiting">Waiting 31–60d</button>
    <button type="button" class="fbtn" data-group="age" data-value="stale">Stale 61d+</button>
  </div>
  <div class="filtergroup">
    <span class="flabel">Detail</span>
    <button type="button" class="fbtn active" data-group="detail" data-value="all">All</button>
    <button type="button" class="fbtn" data-group="detail" data-value="full">Full fork breakdown</button>
    <button type="button" class="fbtn" data-group="detail" data-value="table">Table only</button>
  </div>
  <span class="filtercount" id="docket-filter-count"></span>
</div>

${reviewSection}<section>
  <h2>The docket — ranked by leverage</h2>
  <h3>Prepared and not-yet-prepared, one table for context and ranking ONLY</h3>
  <p><code>unblocks</code> is how many items name this decision as a blocker. <code>to&nbsp;ready</code> is how many of those would become immediately agent-ready once it is ruled. <strong>This table never substitutes for the fork breakdown below</strong>.</p>
  <div class="tw"><table>
    <thead><tr><th>ID</th><th class="ti">Decision</th><th class="n">Unblocks</th><th class="n">To ready</th><th>Waiting</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
</section>

<section>
  <h2>Prepared — full fork detail</h2>
  <h3>Every prepared item, in full — nothing here is a summary</h3>
  <p>Each card below renders the item's own <code>## Fork N</code> sections: every option, the reason each rejected option was rejected, and the recommended default — never compressed to a title and a row.</p>

  <div class="batch">${cards}
  </div>
</section>

<section>
  <h2>Upstream</h2>
  <h3>Not yet prepared</h3>
  <p>These have no researched forks, options or default yet — a decision turn on them would be cold research, not ratification. <code>/prepare</code> closes the gap.</p>
  <div class="tw"><table>
    <thead><tr><th>ID</th><th class="ti">Decision</th><th class="n">Unblocks</th><th class="n">To ready</th><th>Waiting</th></tr></thead>
    <tbody>
${upstreamRows}
    </tbody>
  </table></div>
</section>

<footer>
  <p>${provenance} <code>npm run gen:decision-docket</code>. This page is deterministically generated — no hand edits; fix the data (backlog files) and regenerate instead.</p>
  <p>Ratify with <code>/next decision</code>. Prepare with <code>/prepare &lt;id&gt;</code>.</p>
</footer>

</div>

<script>
(function () {
  "use strict";
  // Client-side only — this is a static published page over a few dozen items, not thousands, so a plain
  // linear filter pass on every click is plenty fast and needs no library.
  var state = { status: 'all', age: 'all', detail: 'all' };
  var targets = null;
  function getTargets() {
    if (!targets) targets = Array.prototype.slice.call(document.querySelectorAll('[data-status]'));
    return targets;
  }
  function apply() {
    var shown = 0;
    var all = getTargets();
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      var match =
        (state.status === 'all' || el.getAttribute('data-status') === state.status) &&
        (state.age === 'all' || el.getAttribute('data-age') === state.age) &&
        (state.detail === 'all' || el.getAttribute('data-detail') === state.detail);
      el.hidden = !match;
      if (match) shown += 1;
    }
    var countEl = document.getElementById('docket-filter-count');
    if (countEl) countEl.textContent = shown + ' / ' + all.length + ' shown';
  }
  var buttons = document.querySelectorAll('.fbtn');
  for (var j = 0; j < buttons.length; j += 1) {
    buttons[j].addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var group = btn.getAttribute('data-group');
      var value = btn.getAttribute('data-value');
      state[group] = value;
      var siblings = document.querySelectorAll('.fbtn[data-group="' + group + '"]');
      for (var k = 0; k < siblings.length; k += 1) siblings[k].classList.toggle('active', siblings[k] === btn);
      apply();
    });
  }
  apply();
})();
</script>
`;
}
