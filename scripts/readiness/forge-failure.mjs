/** Shared infrastructure classification. Policy refusals and ordinary test exits never trip backoff. */
export function isForgeInfraFailure(result) {
  const reason=String(result?.reason ?? '');
  if(/bundle-credential-hit|command-not-allowed/.test(reason))return false;
  if(result?.infraFailure==='install-failed')return true;
  if(result?.mode==='remote')return false;
  return /unreachable|ENOENT|timeout|ssh|transport|install[- ](?:fail|error)|copy-failed/i.test(reason+' '+String(result?.detail ?? ''));
}
