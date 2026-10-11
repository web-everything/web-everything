#!/usr/bin/env node
/**
 * @file scripts/operations/pr-limit.mjs
 * @description The operator-facing CLI for the open-PR backpressure limit (we:xniq7xs, parent #4075):
 *   `node scripts/operations/pr-limit.mjs off --reason=… --operator-quote="<verbatim>" [--for=2h] | on | status | allow --branch=<b> --reason=… --operator-quote="<verbatim>"`
 *   `allow` and `off` are the OPERATOR's exceptions (xfaz7ho): refused from a worker session or a lane clone, refused
 *   without a verbatim operator quote, and `allow` is refused for the caller's own branch — see `authoriseOverride`
 *   in the lib. `on` (re-arm) and `status` (read) stay ungated.
 * All state/decision logic lives in `../lib/pr-limit.mjs` (the pure core + fs shell) — this file is a thin,
 * directly-invocable entry point, kept separate only so the CLI lives under `scripts/operations/` per this
 * repo's convention for operator-facing tools, exactly as the operator's own brief names this path.
 */
import { runPrLimitCli } from '../lib/pr-limit.mjs';

process.exitCode = runPrLimitCli(process.argv.slice(2));
