// `boisestate install` puts a `boisestate` command on the user's PATH. A plugin's
// bin/ folder is only on the PATH of Claude Code's own Bash tool, and the
// install folder changes with every plugin update, so the command it writes
// looks up the installed plugin each time it runs instead of linking to one.

import { accessSync, chmodSync, constants, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The plugin's id in Claude Code's installed plugin list. */
export const PLUGIN_ID = 'boisestate@shanep';

/**
 * The script `boisestate install` writes. It runs the installed plugin's
 * bundle, or the one `install` ran from when the plugin is not installed
 * (such as a checkout loaded with --plugin-dir).
 */
export function shimScript(fallbackRoot: string): string {
  return `#!/usr/bin/env node
// Written by \`boisestate install\`. It finds the installed boisestate plugin on
// each run, so it keeps working when the plugin updates.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 3)) {
  process.stderr.write(
    'boisestate: it needs Node 22.3 or newer, and \`node\` here is ' + process.version + '.\\n' +
      'Run the install script again, or put a newer node first on your PATH.\\n',
  );
  process.exit(1);
}

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


/** Why typing the command would not run the file `boisestate install` wrote. */
export type PathProblem =
  | { readonly kind: 'not-on-path'; readonly dir: string }
  | { readonly kind: 'shadowed'; readonly by: string };

function isCommand(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Checks that the command name finds file: that its folder is on PATH and no
 * other command with the same name comes first. It passes over the folders in
 * skip, such as the plugin's own bin/, which only Claude Code's Bash tool has.
 */
export function pathProblem(
  file: string,
  pathValue: string | undefined,
  skip: readonly string[] = [],
): PathProblem | null {
  const dir = path.resolve(path.dirname(file));
  const skipped = new Set(skip.map((entry) => path.resolve(entry)));
  for (const entry of (pathValue ?? '').split(path.delimiter)) {
    if (entry === '' || skipped.has(path.resolve(entry))) {
      continue;
    }
    if (path.resolve(entry) === dir) {
      return null;
    }
    const other = path.join(path.resolve(entry), path.basename(file));
    if (isCommand(other)) {
      return { kind: 'shadowed', by: other };
    }
  }
  return { kind: 'not-on-path', dir };
}
