#!/usr/bin/env node
/**
 * @file scripts/operations/pr-limit.mjs
 * @description The operator-facing CLI for the open-PR backpressure limit (we:xniq7xs, parent #4075):
 *   `node scripts/operations/pr-limit.mjs off --reason=… [--for=2h] | on | status | allow --branch=<b> --reason=… --operator-quote="<verbatim>"`
 *   `allow` is the OPERATOR's exception (xfaz7ho): refused from a worker session, a lane clone, or for the caller's own
 *   branch, and refused without a verbatim operator quote — see `authoriseAllow` in the lib.
 * All state/decision logic lives in `../lib/pr-limit.mjs` (the pure core + fs shell) — this file is a thin,
 * directly-invocable entry point, kept separate only so the CLI lives under `scripts/operations/` per this
 * repo's convention for operator-facing tools, exactly as the operator's own brief names this path.
 */
import { runPrLimitCli } from '../lib/pr-limit.mjs';

process.exitCode = runPrLimitCli(process.argv.slice(2));
