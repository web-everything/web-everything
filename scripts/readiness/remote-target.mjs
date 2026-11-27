/** Ordered SSH runner discovery. No job, credentials or remote writes are involved. */
export const DEFAULT_REMOTE_HOSTS = Object.freeze([Object.freeze({alias:'forge',root:'/srv/forge-exec'})]);
export function validRemoteHosts(hosts) {
  return Array.isArray(hosts) && hosts.length > 0 && hosts.length <= 32 && hosts.every(host =>
    host && typeof host.alias === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/.test(host.alias)
    && host.root === '/srv/forge-exec');
}

export async function pickRemoteTarget({hosts, exec, cwd, sshOptions, breaker, admit, onSkip} = {}) {
  if (!validRemoteHosts(hosts)) return null;
  exec ??= (await import('./remote-exec.mjs')).defaultExec;
  const skipped = [];
  const skip = entry => { skipped.push(entry); onSkip?.(entry); };
  for (const {alias, root} of hosts) {
    if (breaker) {
      let result;
      try { result = await breaker(alias); }
      catch { skip({alias,reason:'breaker-unreadable'}); continue; }
      if (result?.open !== false) {
        skip({alias,reason:result?.open === true
          ? typeof result.reason === 'string' && result.reason.length > 0 ? result.reason : 'breaker-open'
          : 'breaker-result-invalid'});
        continue;
      }
    }
    let code;
    try {
      ({code} = await exec({file:'ssh', args:['--',alias,'test -x /usr/local/libexec/forge-exec-run.mjs'], cwd,
        timeout:10_000, sshOptions:['-o','ConnectTimeout=5','-o','BatchMode=yes',...(sshOptions ?? [])]}));
    } catch { /* missing or unreadable SSH evidence is unreachable */ }
    if (code !== 0) { skip({alias,reason:code === 1 ? 'runner-missing' : 'ssh-unreachable'}); continue; }
    if (admit) {
      let result;
      try { result = await admit({alias,root}); }
      catch { skip({alias,reason:'remote-health-unreadable'}); continue; }
      if (result?.ok !== true) {
        skip({alias,reason:typeof result?.reason === 'string' && result.reason.length > 0 ? result.reason : 'admit-result-invalid',
          ...(typeof result?.detail === 'string' ? {detail:result.detail} : {})});
        continue;
      }
    }
    return {alias, root, skipped};
  }
  return null;
}

/** Live dry probe: import from node -e; omitted hosts use the normal settings cascade. */
export async function probeRemoteHosts(options = {}) {
  const hosts = options.hosts ?? (await import('./heavy-admission.mjs')).loadAdmissionPolicy({checkoutRoot:options.cwd}).settings.remote.hosts;
  return pickRemoteTarget({...options, hosts});
}
