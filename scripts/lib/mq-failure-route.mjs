import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

const valid = route => route && route.version === 1 && typeof route.repo === 'string'
  && /^[\w.-]+\/[\w.-]+$/.test(route.repo) && Number.isInteger(route.pr) && route.pr > 0
  && /^[a-f0-9]{40}$/.test(route.head) && typeof route.complete === 'boolean'
  && (route.failureProven === undefined || typeof route.failureProven === 'boolean')
  && ['failedJobs', 'testFiles', 'assertions'].every(key => Array.isArray(route[key])
    && route[key].length <= 100 && route[key].every(s => typeof s === 'string' && s.length <= 8192));
export function buildMqFailureRoute(route) {
  const payload = { version: 1, repo: route.repo, pr: route.pr, head: route.head,
    failedJobs: route.failedJobs, testFiles: route.testFiles, assertions: route.assertions, complete: route.complete,
    ...(route.failureProven !== undefined ? { failureProven: route.failureProven } : {}) };
  if (!valid(payload)) throw new TypeError('Invalid MQ route evidence');
  // JSON escapes keep hostile log newlines and HTML terminators inside one inert leading marker.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  if (json.length > 128 * 1024) throw new Error('MQ route oversized; operator inspection required');
  return `<!-- mq-failure-recovery:v1 ${json} -->\nMQ failure recovery: inspect the head-bound failed jobs and test evidence above.`;
}
export function parseMqFailureRoute({ comment, expected }) {
  if (!isTrustedMarkerAuthor(comment) || typeof comment.body !== 'string' || !expected) return null;
  const line = comment.body.split('\n', 1)[0];
  if (line.length > 128 * 1024 + 40) return null;
  const match = /^<!-- mq-failure-recovery:v1 (.+) -->$/.exec(line);
  if (!match) return null;
  try {
    const route = JSON.parse(match[1]);
    if (!valid(route) || route.repo !== expected.repo || route.pr !== expected.pr) return null;
    return { ...route, stale: route.head !== expected.head };
  } catch { return null; }
}
