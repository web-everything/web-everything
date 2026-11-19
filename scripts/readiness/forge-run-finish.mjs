import {execFile} from 'node:child_process';

export const RUN_FINISH_TIMEOUT_MS = 10_000;

/** Consume a settled run for a dead client. Requests use stdin, never shell interpolation. */
export function createRunFinisher({host, exec = execFile, timeoutMs = RUN_FINISH_TIMEOUT_MS} = {}) {
  return async ({run, nonce, cancel}) => {
    if (typeof host !== 'string' || typeof run !== 'string' || typeof nonce !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/.test(host)
      || !/^r-[a-f0-9]{32}(?![\s\S])/.test(run ?? '') || !/^[a-f0-9]{32}(?![\s\S])/.test(nonce ?? '')) throw new Error('Invalid finish parameters');
    return new Promise((resolve, reject) => {
      const child = exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host,
        'sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs finish'],
      {timeout: cancel === true ? 90_000 : timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8'}, (error, stdout, stderr) => {
        if (!error) return resolve({finished: true});
        // Any failure, including consumed-state errors, is not proof of termination: retain the marker. A consumed
        // run drops out of fresh telemetry, where the reaper's ordinary finished/absent rules decide.
        error.stderr = stderr;
        reject(error);
      });
      child.stdin.on('error', () => { /* exec's callback reports a failed transport */ });
      child.stdin.end(JSON.stringify({nonce, run, ...(cancel === true ? {cancel: true} : {})}));
    });
  };
}
