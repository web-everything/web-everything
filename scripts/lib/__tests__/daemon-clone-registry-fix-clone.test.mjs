import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_CLONE_SEED } from '../daemon-clone-registry.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLIST = readFileSync(join(REPO, 'skills-src/conveyor/launchd/com.we.fix-dispatch-daemon.plist.example'), 'utf8');

describe('fix-dispatch daemon has its own clone', () => {
  it('registers wev-fix-daemon as a daemon clone, distinct from the review daemon clone', () => {
    expect(DAEMON_CLONE_SEED).toContain('wev-fix-daemon');
    expect(DAEMON_CLONE_SEED).toContain('wev-review-daemon');
  });
  it('the plist template runs entirely from wev-fix-daemon, never wev-review-daemon', () => {
    expect(PLIST).toContain('<string>com.we.fix-dispatch-daemon</string>');
    expect(PLIST).not.toContain('wev-review-daemon');
    expect(PLIST).toContain('/workspace/wev-fix-daemon/skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    expect(PLIST).toContain('/workspace/wev-fix-daemon/.conveyor/fix-dispatch-daemon.log');
    expect(PLIST).toMatch(/<key>WorkingDirectory<\/key>\s*<string>[^<]*\/workspace\/wev-fix-daemon<\/string>/);
  });
  it('the template carries the fix daemon env knobs and no secrets', () => {
    expect(PLIST).toContain('WE_FIX_BORROW_BUILD_SLOTS');
    expect(PLIST).toContain('WE_FIX_DISPATCH_MAX_CONCURRENT');
    expect(PLIST).not.toMatch(/PRIVATE_KEY|PR_EVENTS_TOKEN/);
  });
});
