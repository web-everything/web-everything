/** Shared byte bound for the host's growing platform settings bag. */
import * as nativeFs from 'node:fs';
export const PLATFORM_FILE_MAX_BYTES = 4 * 1024 * 1024;

export function boundedPlatformText(path, fs = nativeFs, limit = PLATFORM_FILE_MAX_BYTES) {
  const fd = fs.openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > limit) throw Error(`file larger than ${limit} bytes`);
    return bytes.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}
