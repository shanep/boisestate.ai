// `boisestate install` puts a `boisestate` command on the user's PATH. A plugin's
// bin/ folder is only on the PATH of Claude Code's own Bash tool, and the
// install folder changes with every plugin update, so the command it writes
// looks up the installed plugin each time it runs instead of linking to one.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The plugin's id in Claude Code's installed plugin list. */
export const PLUGIN_ID = 'boisestate@boisestate-ai';

/**
 * The script `boisestate install` writes. It runs the installed plugin's
 * bundle, or the one `install` ran from when the plugin is not installed
 * (such as a checkout loaded with --plugin-dir).
 */
export function shimScript(fallbackRoot: string): string {
  return `#!/usr/bin/env node
// Written by \`boisestate install\`. It finds the installed boisestate plugin on
// each run, so it keeps working when the plugin updates.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const fallback = ${JSON.stringify(fallbackRoot)};

function bundleIn(root) {
  const file = path.join(root, 'dist', 'boisestate.cjs');
  return fs.existsSync(file) ? file : null;
}

function installed() {
  try {
    const list = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    for (const entry of list.plugins[${JSON.stringify(PLUGIN_ID)}] || []) {
      const file = bundleIn(entry.installPath);
      if (file !== null) {
        return file;
      }
    }
  } catch {
    // No list, or not one this script understands, so use the fallback.
  }
  return null;
}

const bundle = installed() || bundleIn(fallback);
if (bundle === null) {
  process.stderr.write(
    'boisestate: the boisestate plugin is not installed. Run: claude plugin install ${PLUGIN_ID}\\n',
  );
  process.exit(1);
}
require(bundle);
`;
}

/** Writes the command into dir and returns its path. */
export function installShim(dir: string, fallbackRoot: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'boisestate');
  writeFileSync(file, shimScript(fallbackRoot));
  chmodSync(file, 0o755);
  return file;
}

/** True when dir is one of PATH's folders. */
export function onPath(dir: string, pathValue: string | undefined): boolean {
  return (pathValue ?? '')
    .split(path.delimiter)
    .some((entry) => entry !== '' && path.resolve(entry) === path.resolve(dir));
}
