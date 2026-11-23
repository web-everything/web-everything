import { parseDelegationMarker } from './delegation-marker.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { vendorOfModel } from './review-seat-provider.mjs';

const unknown = (source = 'none') => ({ provider: 'unknown', model: 'unknown', taskType: null, delegated: false, source });
const providerVendor = provider => provider === 'gemini' ? 'Google' : vendorOfModel(provider);
const consistent = row => Boolean(providerVendor(row.provider)) && (!vendorOfModel(row.model) || providerVendor(row.provider) === vendorOfModel(row.model));

// Completed build dispatches and interactive delegations share the scorecard ledger.
// An unreadable ledger is unknown evidence, never permission to trust editable PR text.
const readBuilderRecords = () => readStore({ path: resolveScorecardStorePath(), strict: true }).records;

export function resolveBuilder({ body = '', headMessage = '', repo, pr, branch, lane, head } = {}, { readRecords = readBuilderRecords } = {}) {
  const d = parseDelegationMarker(String(body ?? ''));
  if (d && !consistent(d)) return unknown('conflicting-identity');
  if (pr != null || branch || lane) {
    let records;
    try { records = readRecords(); if (!Array.isArray(records)) throw new Error('invalid ledger'); }
    catch { return unknown('unreadable-dispatch-ledger'); }
    const subjectRecords = records.filter(row => row && ['build', 'session-delegation'].includes(row.dispatchKind)
      && (!row.repo || row.repo === repo)
      && ((pr != null && row.pr != null && String(row.pr) === String(pr))
        || (branch && row.branch === branch) || (lane && row.lane === lane)));
    // PRs can be rebuilt: only the dispatch for the reviewed revision is authoritative.
    const revision = row => row.rev ?? row.head ?? row.headSha;
    const validHead = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
    if (subjectRecords.length && !validHead(head)) return unknown('missing-reviewed-revision');
    const matches = subjectRecords.filter(row => validHead(revision(row)) && revision(row).toLowerCase() === head.toLowerCase());
    if (!matches.length && subjectRecords.some(row => !validHead(revision(row)))) return unknown('unversioned-dispatch-ledger');
    if (matches.length) {
      const identity = matches[0];
      if (matches.some(row => !consistent(row) || row.provider !== identity.provider || row.model !== identity.model)
        || (d && (d.provider !== identity.provider || d.model !== identity.model))) return unknown('conflicting-dispatch-ledger');
      return { provider: identity.provider, model: identity.model, taskType: identity.taskType ?? null, delegated: true, source: 'dispatch-ledger' };
    }
  }
  if (d) return { provider: d.provider, model: d.model, taskType: d.taskType, delegated: true, source: 'delegation-marker' };
  const m = String(headMessage ?? '').match(/^Co-Authored-By:\s*Claude\s+([^<\n]+?)\s*</im);
  if (m) {
    const model = `claude-${m[1].replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/\s+/g, '-')}`;
    return { provider: 'claude', model, taskType: null, delegated: false, source: 'co-authored-by' };
  }
  return unknown();
}

