/** Early read-only size check; accounting and limit belong to open-pr. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { measureNonTestLines, OPEN_PR_MAX_NON_TEST_LINES } from './open-pr.mjs';

export const PR_SIZE_OP = 'pr-size';
const scope = 'committed HEAD vs refs/remotes/origin/main (local main ignored); working-tree changes excluded';

export function prSizeOperation({ readDiff } = {}) {
  if (typeof readDiff !== 'function') throw new TypeError('pr-size: needs an injected readDiff()');
  return op(PR_SIZE_OP, {
    input: { checkout: { type: 'string', required: true } },
    verdictFrom: 'run',
    run: compute({
      reads: ['input.checkout'],
      fn: (view) => {
        const limit = OPEN_PR_MAX_NON_TEST_LINES;
        try {
          const evidence = readDiff({ checkout: view.input.checkout });
          const size = measureNonTestLines(typeof evidence === 'string' ? evidence : evidence?.text);
          const ok = size.exempt || size.lines <= limit;
          return { ...size, limit, ok, status: ok ? 'ok' : 'over', scope,
            detail: size.exempt ? 'backlog-only exempt' : ok ? '' : 'Stop and propose a split plan instead of finishing the build.' };
        } catch {
          return { lines: null, limit, ok: false, status: 'unreadable', scope,
            detail: 'Stop; restore readable git diff evidence and retry before verify/converge.' };
        }
      },
    }),
  });
}

/** The generic CLI completion line omits verdicts; expose the measured result. */
export function finishPrSize({ run, code, lines, json = false }) {
  const verdict = run?.verdict;
  if (!verdict) return { code, lines };
  return {
    code: verdict.ok ? code : 1,
    lines: json ? lines : [
      `pr-size: ${verdict.lines ?? 'unknown'}/${verdict.limit} non-test lines — ${verdict.status}. ${verdict.detail}`,
      verdict.scope,
    ],
  };
}
