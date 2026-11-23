/**
 * Behavioral conformance vectors (#1016) — the WE-owned substrate for the #899 conformance KIT. Ships the
 * vector **schema** + dependency-free structural **validator**, and the per-standard vector **suites**.
 * The runtime driver that executes a suite against a candidate component lives in plateau/FUI per #899
 * (#817 split · #091 hosted→plateau); WE owns only the build-agnostic contract — the vectors and the shape.
 *
 * Pattern: each implemented standard ships a `<standard>.vectors.ts` exporting a `ConformanceVectorSuite`
 * that passes `assertConformanceSuite`. `validator-resolution` is the pattern-establishing exemplar; the
 * remaining standards are the #1042 L3-completion backfill.
 */
export * from './schema.js';
export { validatorResolutionSuite } from './validator-resolution.vectors.js';
export { sessionReplayEnvelopeSuite } from './session-replay-envelope.vectors.js';
export { slideTransitionReducedMotionSuite } from './slide-transition-reduced-motion.vectors.js';
export { presentationA11ySuite } from './presentation-a11y.vectors.js';
export { navListA11ySuite } from './nav-list-a11y.vectors.js';
export { textNodeSuite } from './text-node.vectors.js';
export { treegridArbitrationSuite } from './treegrid-arbitration.vectors.js';
export { webpolicySuite } from './webpolicy.vectors.js';
export { webprocessSuite } from './webprocess.vectors.js';
export { webcomplianceSuite } from './webcompliance.vectors.js';
export { intlSuite } from './intl.vectors.js';
export { analyticsSuite } from './analytics.vectors.js';
export { reliabilitySuite } from './reliability.vectors.js';
export { webthemeSuite } from './webtheme.vectors.js';
export { timeTrackSuite } from './time-track.vectors.js';
// The Doc Spec suite (#1163) is a pure (manifest, cases) → DocsSite golden-vector suite, a different shape
// from the interaction-script ConformanceVectorSuite — exported on its own, not in `conformanceSuites`.
export { webdocsDocSpecSuite, assertDocSpecSuite, DocSpecSchemaError } from './webdocs.vectors.js';
// The Web Directives SSR wire-format suite (#2063/#2030) is a pure (directive tree + data) → exact HTML bytes
// golden-vector suite — like webdocs, a different shape from the interaction-script ConformanceVectorSuite, so
// exported on its own, not in `conformanceSuites`. It pins the language-agnostic SSR wire format every renderer
// conforms to (the FUI Node reference renderer #2064 is the oracle). Its language-neutral JSON export
// (`webdirectives-ssr.vectors.json`) + cross-language grading harness contract
// (`webdirectives-ssr-harness-contract.md`) are #2354 — what every non-JS renderer (#2069) is graded against.
export {
  webdirectivesSsrSuite,
  assertSsrWireSuite,
  SsrWireSchemaError,
  djb2KeyHash,
} from './webdirectives-ssr.vectors.js';
export type { SsrWireVector, SsrWireVectorSuite } from './webdirectives-ssr.vectors.js';

import type { ConformanceVectorSuite } from './schema.js';
import { validatorResolutionSuite } from './validator-resolution.vectors.js';
import { sessionReplayEnvelopeSuite } from './session-replay-envelope.vectors.js';
import { slideTransitionReducedMotionSuite } from './slide-transition-reduced-motion.vectors.js';
import { presentationA11ySuite } from './presentation-a11y.vectors.js';
import { navListA11ySuite } from './nav-list-a11y.vectors.js';
import { textNodeSuite } from './text-node.vectors.js';
import { treegridArbitrationSuite } from './treegrid-arbitration.vectors.js';
import { webpolicySuite } from './webpolicy.vectors.js';
import { webprocessSuite } from './webprocess.vectors.js';
import { webcomplianceSuite } from './webcompliance.vectors.js';
import { intlSuite } from './intl.vectors.js';
import { analyticsSuite } from './analytics.vectors.js';
import { reliabilitySuite } from './reliability.vectors.js';
import { webthemeSuite } from './webtheme.vectors.js';
import { timeTrackSuite } from './time-track.vectors.js';

/** The registry of shipped per-standard suites — what the #899 driver enumerates. */
export const conformanceSuites: ReadonlyArray<ConformanceVectorSuite> = [
  validatorResolutionSuite,
  sessionReplayEnvelopeSuite,
  slideTransitionReducedMotionSuite,
  presentationA11ySuite,
  navListA11ySuite,
  textNodeSuite,
  treegridArbitrationSuite,
  webpolicySuite,
  webprocessSuite,
  webcomplianceSuite,
  intlSuite,
  analyticsSuite,
  reliabilitySuite,
  webthemeSuite,
  timeTrackSuite,
];
