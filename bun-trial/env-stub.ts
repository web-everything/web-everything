// bun:test has no vi.stubEnv / vi.unstubAllEnvs. This is the smallest native stand-in (finding for xkd7crs).
const saved = new Map<string, string | undefined>();
export function stubEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = String(value);
}
export function unstubAllEnvs(): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
}
