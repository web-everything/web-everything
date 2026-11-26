/** Shared publication-sink history validation, extracted from file-item's batch publisher.
 * A net diff cannot reveal reverted code or merged side-parent history.
 * run accepts argv, optional stdin, and a flag preserving raw NUL-delimited output.
 */
export function validateCardPublicationHistory({ run, main, head }) {
  const baseline = run(['merge-base', '--all', main, head]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseline)) throw new Error('ambiguous card publication baseline');
  const range = `${baseline}..${head}`;
  if (run(['rev-list', '--min-parents=2', '--max-count=1', range])) {
    throw new Error('remote batch contains merge commits');
  }
  const raw = run(['log', '--format=', '--name-only', '--no-renames', '-z', range], undefined, true);
  if (raw && !raw.endsWith('\0')) throw new Error('incomplete card publication history; inspect before retrying');
  const paths = raw.split('\0').filter(Boolean);
  if (paths.some(path => !/^backlog\/[^/\\\x00-\x1f]+\.md$/.test(path))) {
    throw new Error('remote batch contains non-card changes');
  }
  return baseline;
}
