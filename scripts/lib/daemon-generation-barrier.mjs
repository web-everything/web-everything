/**
 * @file scripts/lib/daemon-generation-barrier.mjs — BLUE-GREEN-SWAP S1.2 v2: single-writer handover by ORDERED EXIT.
 *
 * Invariant (I): a new daemon generation performs its first effect only after the supervising gate has
 * confirmed (ESRCH) that the old generation's whole process group is gone. Two generations never act at once,
 * because the old one no longer exists. No fence, no lease field, no mutex (a concurrent fence cannot be made
 * atomic against GitHub, which cannot refuse a stale writer).
 *
 * Pure except for the injected group probe. The gate (S1.1) and blue's exit (S1.4) call these; S1.2 adds no
 * call site. Spec: flow/daemon-profile FLOW-DMN-009..016, 045..050; Standards G2 (YES, on conditions): the
 * ESRCH proof is tied to a start identity recorded at spawn, an unclean blue costs a settle bound plus a
 * reconcile read, and new-session spawns are refused (clause ids FLOW-DMN-051+ pending in daemon-profile v0.1.4).
 */

import ts from 'typescript';

export const GROUP_PROBE_MS = 100;
export const GROUP_DEATH_TIMEOUT_MS = 30_000;
export const HANDOVER_EXIT_CODE = 77;
/** Default settle bound after an unclean blue: at least blue's `gh` request timeout (S1.4 passes the real one). */
export const DEFAULT_GH_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The only spawns allowed to start a new session/process group. An entry names the file it may appear in and the
 * command in that spawn call, so a comment or another command nearby cannot exempt a different spawn.
 * `osascript` (a notification) and `deps-job` (npm ci) cannot merge. `drain-followup-job` is the post-merge
 * follow-up job (x4y74wj): it survives its leader on purpose, is serialized by its own job store and resumed by
 * the next generation's reattach tick. KNOWN GAP against invariant I, carded in the PR; it is listed, not hidden.
 */
export const MERGE_CAPABLE_SPAWN_ALLOWLIST = Object.freeze([
  { name: 'osascript', file: 'branch-sync.mjs', command: 'osascript' },
  { name: 'deps-job', file: 'deps-job.mjs', command: 'deps-job' },
  { name: 'drain-followup-job', file: 'daemon-jobs-runtime.mjs', nodeEntry: 'entryPath' },
]);

/**
 * Wait for the whole group to be gone. `'dead'` only on ESRCH AND explicit absence of the recorded leader; anything else that
 * is not a plain "still alive until timeout" is `'unknown'` (no promotion). `identity` is the leader's start
 * identity recorded at spawn (pid start time or a spawn nonce); `probeIdentity(pgid)` returns the identity now
 * on that pgid's leader pid, or null when it is gone. A different identity means the pgid was reused: unknown.
 * @returns {Promise<'dead'|'alive'|'unknown'>}
 */
export async function awaitGroupDeath({ pgid, identity = null, probeIdentity = null, killGroup, sleep, probeMs = GROUP_PROBE_MS, timeoutMs = GROUP_DEATH_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 1 || typeof killGroup !== 'function' || typeof sleep !== 'function') return 'unknown';
  if (typeof probeIdentity !== 'function') return 'unknown'; // the identity check is mandatory, never defaulted away
  if (!Number.isFinite(probeMs) || !(probeMs > 0) || !Number.isFinite(timeoutMs) || !(timeoutMs >= 0)) return 'unknown';
  if (identity == null || identity === '') return 'unknown'; // no recorded start identity: the proof cannot be tied to our spawn
  for (let waited = 0; ; waited += probeMs) {
    let now;
    try { now = probeIdentity(pgid); } catch { return 'unknown'; }
    if (now !== null && now !== identity) return 'unknown'; // reused pgid or missing identity evidence
    let denied = false;
    try { killGroup(pgid, 0); } catch (error) {
      // ESRCH for -pid does not prove a live pid leads a group. Only null means the leader is gone.
      if (error?.code === 'ESRCH') return now === null ? 'dead' : 'unknown';
      if (error?.code !== 'EPERM') return 'unknown';
      denied = true; // Darwin can report EPERM briefly while an exiting group becomes ESRCH.
    }
    if (waited >= timeoutMs) return denied ? 'unknown' : 'alive';
    await sleep(Math.min(probeMs, timeoutMs - waited));
  }
}

/**
 * Settle decision for the first act of a new generation. A clean blue (exit 77 AND nothing in flight) needs no
 * wait. Otherwise a request blue sent may still land at the store: green waits until `lastSendAt + bound`
 * (bound >= blue's gh request timeout) and its first act is a reconcile read. Unknown send time waits the full
 * bound from now. Pure.
 * @returns {{waitMs:number, reconcileFirst:boolean, clean:boolean}}
 */
export function settleDecision({ exitCode, inFlight, lastSendAt = null, nowMs, ghRequestTimeoutMs = DEFAULT_GH_REQUEST_TIMEOUT_MS, settleMs = 0 } = {}) {
  const clean = exitCode === HANDOVER_EXIT_CODE && inFlight === 0;
  if (clean) return { waitMs: 0, reconcileFirst: false, clean: true };
  // A zero, negative or non-finite timeout is never trusted: it falls back to the default bound.
  const bound = Math.max(Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 0, Number.isFinite(ghRequestTimeoutMs) && ghRequestTimeoutMs > 0 ? ghRequestTimeoutMs : DEFAULT_GH_REQUEST_TIMEOUT_MS);
  const anchor = Number.isFinite(lastSendAt) && Number.isFinite(nowMs) ? lastSendAt : nowMs;
  const waitMs = Number.isFinite(anchor) && Number.isFinite(nowMs) ? Math.max(0, anchor + bound - nowMs) : bound;
  return { waitMs, reconcileFirst: true, clean: false };
}

/**
 * Promote the candidate only when every condition holds; anything absent or unknown refuses.
 * A promotion after an unclean blue still carries the settle decision (wait + reconcile read first).
 */
export function decidePromotion({ exitCode, groupDeath, recordWritten, candidate, expectedDigest, inFlight, lastSendAt = null, nowMs, ghRequestTimeoutMs, settleMs } = {}) {
  if (groupDeath !== 'dead') return { promote: false, reason: groupDeath === 'alive' ? 'group-alive' : 'group-death-unknown' };
  if (recordWritten !== true) return { promote: false, reason: 'record-not-written' };
  if (!candidate || !Number.isInteger(candidate.pid) || candidate.pid <= 1 || candidate.alive !== true) return { promote: false, reason: 'candidate-dead' };
  if (candidate.ready !== true) return { promote: false, reason: 'candidate-not-ready' };
  if (!expectedDigest || candidate.codeDigest !== expectedDigest) return { promote: false, reason: 'digest-mismatch' };
  if (!Number.isInteger(inFlight) || inFlight < 0) return { promote: false, reason: 'in-flight-unknown' };
  if (!Number.isInteger(exitCode)) return { promote: false, reason: 'exit-code-unknown' };
  const settle = settleDecision({ exitCode, inFlight, lastSendAt, nowMs, ghRequestTimeoutMs, settleMs });
  if (settle.clean) return { promote: true, to: candidate, waitMs: 0, reconcileFirst: false };
  // Not a clean handover (killed, crashed, not 77, or work in flight): the group is dead, but green settles first.
  return { promote: true, to: candidate, waitMs: settle.waitMs, reconcileFirst: true, unclean: true };
}

/** Blue's pass-boundary check (S1.4 calls it). A refusal means blue keeps passing. */
export function mayHandOver({ holdingLease, paused, currentChild, eoeIdle, sourcesStopped } = {}) {
  if (holdingLease !== true) return { ok: false, reason: 'lease-not-held' };
  if (paused !== false) return { ok: false, reason: 'paused' }; // absent state is not "not paused"
  if (currentChild !== null) return { ok: false, reason: 'child-running' };
  if (eoeIdle !== true) return { ok: false, reason: 'eoe-busy' };
  if (sourcesStopped !== true) return { ok: false, reason: 'sources-live' };
  return { ok: true };
}

const SESSION_COMMAND_RE = /\b(?:setsid|setpgid|setpgrp|launchctl)\b|start_new_session|new[-_ ]session/;
// Child `node -e` / shell source can itself contain a spawn. Keep the former conservative check on string data.
const DETACHED_SOURCE_RE = /\bdetached\s*[:=]|['"`]detached['"`]\s*\]?\s*[:=]|[{,]\s*detached\s*[,}]/;

// Resolve literal spelling variants without executing source (escapes, templates, concatenation, parentheses).
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isComputedPropertyName(node)) return literalText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left), right = literalText(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = literalText(span.expression);
      if (value === null) return null;
      text += value + span.literal.text;
    }
    return text;
  }
  return null;
}

const propertyName = (node) => node && ts.isIdentifier(node) ? node.text : literalText(node);
const memberName = (node) => ts.isPropertyAccessExpression(node) ? node.name.text
  : ts.isElementAccessExpression(node) ? literalText(node.argumentExpression) : null;

function hasEscapeTarget(node) {
  if (['detached', 'start_new_session'].includes(memberName(node))) return true;
  if (ts.isParenthesizedExpression(node) || ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return hasEscapeTarget(node.expression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(hasEscapeTarget);
  if (ts.isObjectLiteralExpression(node)) return node.properties.some((property) =>
    ts.isPropertyAssignment(property) ? hasEscapeTarget(property.initializer)
      : ts.isSpreadAssignment(property) && hasEscapeTarget(property.expression));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return hasEscapeTarget(node.left);
  return false;
}

function allowedDetachment(node, file, allowlist) {
  // Only a direct option on this exact spawn can be exempt. Nested spawns and standalone writes cannot borrow it.
  const options = node.parent, call = options?.parent;
  if (!options || !ts.isObjectLiteralExpression(options) || !call || !ts.isCallExpression(call)
    || call.arguments[2] !== options || !ts.isIdentifier(call.expression) || call.expression.text !== 'spawn') return false;
  return allowlist.some((entry) => {
    if (entry.file !== file || file === null) return false;
    if (entry.command) return literalText(call.arguments[0]) === entry.command;
    const command = call.arguments[0], args = call.arguments[1];
    return !!entry.nodeEntry && command && ts.isPropertyAccessExpression(command)
      && ts.isIdentifier(command.expression) && command.expression.text === 'process' && command.name.text === 'execPath'
      && args && ts.isArrayLiteralExpression(args) && args.elements.length === 1
      && ts.isIdentifier(args.elements[0]) && args.elements[0].text === entry.nodeEntry;
  });
}

/**
 * Scan executable syntax for group escapes, including detached option writes and session launchers.
 * Only a detached option belonging directly to an allowlisted spawn in its declared file is exempt.
 * The parser handles comment markers in strings, regexes and templates; unreadable syntax fails closed.
 * @returns {{line:number, text:string}[]} violations
 */
export function scanNewSessionSpawns(source, { file = null, allowlist = MERGE_CAPABLE_SPAWN_ALLOWLIST } = {}) {
  const out = [];
  if (typeof source !== 'string') return [{ line: 1, text: 'Unreadable source; inspect before permitting handover' }];
  const tree = ts.createSourceFile('source.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) return [{ line: 1, text: 'Unreadable syntax; inspect before permitting handover' }];
  const report = (node) => out.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, text: node.getText(tree) });
  const visit = (node) => {
    if (node.parent && ts.isObjectLiteralExpression(node.parent) && node.name) {
      const key = propertyName(node.name);
      if (key === 'detached' || key === 'start_new_session') {
        const directOption = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node);
        if (key !== 'detached' || !directOption || !allowedDetachment(node, file, allowlist)) report(node);
        // Still inspect initializers: an allowed option cannot hide another call or property write.
        if (ts.isPropertyAssignment(node)) visit(node.initializer);
        else if (node.body) visit(node.body);
        return;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && hasEscapeTarget(node.left)) {
      report(node);
      visit(node.right);
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && hasEscapeTarget(node.operand)) {
      report(node);
      return;
    }
    // Reflective writes are another spelling of opts.detached = value.
    if (ts.isCallExpression(node) && ['defineProperty', 'set'].includes(memberName(node.expression))
      && ['detached', 'start_new_session'].includes(literalText(node.arguments[1]))) {
      report(node);
      for (const argument of node.arguments.slice(2)) visit(argument);
      return;
    }
    // Scan literal values as a whole first so 'launch' + 'ctl' cannot evade the launcher denylist.
    const literal = literalText(node);
    if (literal !== null && (SESSION_COMMAND_RE.test(literal) || DETACHED_SOURCE_RE.test(literal))) { report(node); return; }
    if (ts.isIdentifier(node) && SESSION_COMMAND_RE.test(node.text)) { report(node); return; }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}
