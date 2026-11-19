#!/usr/bin/env node
/** Render the guard-sync launchd template for installation on this host. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinDeveloperDir } from '../lib/lane-git-hardening.mjs';

const templatePath = join(dirname(fileURLToPath(import.meta.url)), 'com.we.guard-main-sync.plist.template');
const fields = ['NODE_PATH', 'GUARD_CLONE_PATH', 'ORIGIN_URL', 'EXECUTABLE_PATH', 'LOG_DIRECTORY'];
const escapeXml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

/** Explicit host inputs and an injectable CLT probe; never mutates the caller's environment. */
export function renderGuardSyncPlist(values, { env = process.env, exists = existsSync } = {}) {
  const replacements = {};
  for (const field of fields) {
    if (typeof values[field] !== 'string' || !values[field]) throw new Error(`missing ${field}`);
    replacements[field] = escapeXml(values[field]);
  }
  const { DEVELOPER_DIR } = pinDeveloperDir({ DEVELOPER_DIR: env.DEVELOPER_DIR }, { exists });
  replacements.DEVELOPER_DIR_ENV = DEVELOPER_DIR
    ? `    <key>DEVELOPER_DIR</key><string>${escapeXml(DEVELOPER_DIR)}</string>` : '';
  return readFileSync(templatePath, 'utf8').replace(/__([A-Z_]+)__/g, (_match, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`unknown template field ${key}`);
    return replacements[key];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = {};
    for (const arg of process.argv.slice(2)) {
      const match = /^--([a-z-]+)=(.*)$/s.exec(arg);
      const key = match?.[1].replaceAll('-', '_').toUpperCase();
      if (!fields.includes(key)) throw new Error(`unknown argument: ${arg}`);
      values[key] = match[2];
    }
    writeFileSync(1, renderGuardSyncPlist(values));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
