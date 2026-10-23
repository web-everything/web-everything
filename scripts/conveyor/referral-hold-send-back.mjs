#!/usr/bin/env node
/**
 * stale-hold-resume — the review daemon's send-back for a referral pause whose live-head findings are ruled `block`:
 * the SAME follow-up effect `record-referral-ruling` runs for a block ruling
 * (`record-referral-ruling-io.mjs#createRecordReferralRulingSinks`: head re-check, `review-set-label --to=changes`,
 * the ledger send-back row). That effect is async and the daemon's tick is not, so the daemon runs this file as a
 * short child process. Input: JSON in env `WE_AUTO_RESOLVE_SEND_BACK`; output: the effect's result as one JSON line.
 * Static imports only, so the daemon's import scanner sees a complete list.
 */
import { createRecordReferralRulingSinks } from '../operations/record-referral-ruling-io.mjs';
import { OPERATOR_RULING_FOLLOW_UP_EFFECT } from '../operations/record-referral-ruling.mjs';

const args = JSON.parse(process.env.WE_AUTO_RESOLVE_SEND_BACK ?? 'null');
if (!args || typeof args !== 'object') { process.stderr.write('referral-hold-send-back: WE_AUTO_RESOLVE_SEND_BACK is required\n'); process.exit(2); }
const result = await createRecordReferralRulingSinks()[OPERATOR_RULING_FOLLOW_UP_EFFECT]({ ...args, action: 'send-back' });
process.stdout.write(`${JSON.stringify(result)}\n`);
