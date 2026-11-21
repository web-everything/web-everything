/** Serve complete REST pages for a synthetic PR head; provenance is attested by the real reader.
 * Self-contained so hermetic gh executables can embed this function alongside their PR database.
 * Targeted check-name reads stay with the caller's freshness/failure simulator.
 */
export function completeCheckReadFixture(prs, argv) {
  if (argv[0] !== 'api' || !argv.includes('--paginate') || !argv.includes('--slurp')) return undefined;
  const path = argv.find(arg => arg.startsWith('repos/')) || '';
  const match = /^repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/(check-runs|status)\?(.+)$/.exec(path);
  if (!match || (match[2] === 'check-runs' && !match[3].split('&').includes('filter=all'))) return undefined;
  const pr = prs.find(pr => pr.headRefOid === match[1]);
  if (!pr || !Array.isArray(pr.statusCheckRollup)) throw new Error('missing complete check fixture for ' + match[1]);
  const rows = pr.statusCheckRollup;
  if (match[2] === 'check-runs') {
    const check_runs = rows.filter(row => !row.context).map((row, i) => ({ ...row, id: row.id ?? -(i + 1),
      status: row.status?.toLowerCase(), conclusion: row.conclusion?.toLowerCase(),
    }));
    return [{ total_count: check_runs.length, check_runs }];
  }
  const statuses = rows.filter(row => row.context).map((row, i) => ({ ...row, id: row.id ?? -(i + 1),
    state: row.state?.toLowerCase(), target_url: row.target_url ?? row.targetUrl,
  }));
  return [{ total_count: statuses.length, statuses }];
}
