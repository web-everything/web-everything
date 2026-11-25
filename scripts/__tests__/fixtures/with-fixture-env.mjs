/** Embed routing in executable shims whose callers scrub the child environment. */
export function withFixtureEnv(source, env) {
  const newline = source.indexOf('\n');
  if (!source.startsWith('#!') || newline < 0) {
    throw new Error('Executable fixture requires a newline-terminated shebang');
  }
  const offset = newline + 1;
  // Insert once after the shebang; replacement strings would expand $&, $` and $' in paths.
  return source.slice(0, offset) + 'Object.assign(process.env, ' + JSON.stringify(env) + ');\n' + source.slice(offset);
}
