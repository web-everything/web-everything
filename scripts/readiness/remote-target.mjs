/** Ordered SSH runner discovery. No job, credentials or remote writes are involved. */
export const DEFAULT_REMOTE_HOSTS = Object.freeze([Object.freeze({alias:'forge',root:'/srv/forge-exec'})]);
export function validRemoteHosts(hosts) {
  return Array.isArray(hosts) && hosts.length > 0 && hosts.length <= 32 && hosts.every(host =>
    host && typeof host.alias === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/.test(host.alias)
    && host.root === '/srv/forge-exec');
}

export async function pickRemoteTarget({hosts, exec, cwd, sshOptions} = {}) {
  if (!validRemoteHosts(hosts)) return null;
  exec ??= (await import('./remote-exec.mjs')).defaultExec;
  const skipped = [];
  for (const {alias, root} of hosts) {
    let code;
    try {
      ({code} = await exec({file:'ssh', args:['--',alias,'test -x /usr/local/libexec/forge-exec-run.mjs'], cwd,
        timeout:10_000, sshOptions:['-o','ConnectTimeout=5','-o','BatchMode=yes',...(sshOptions ?? [])]}));
    } catch { /* missing or unreadable SSH evidence is unreachable */ }
    if (code === 0) return {alias, root, skipped};
    skipped.push({alias, reason:code === 1 ? 'runner-missing' : 'ssh-unreachable'});
  }
  return null;
}

/** Live dry probe: import from node -e; omitted hosts use the normal settings cascade. */
export async function probeRemoteHosts(options = {}) {
  const hosts = options.hosts ?? (await import('./heavy-admission.mjs')).loadAdmissionPolicy({checkoutRoot:options.cwd}).settings.remote.hosts;
  return pickRemoteTarget({...options, hosts});
}
