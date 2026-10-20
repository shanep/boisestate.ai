// The `boisestate` command. With no subcommand it runs Claude Code on
// boisestate.ai and passes every arg on to `claude`.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { configFromEnv } from '../bridge/config.js';

import { startBridge } from './bridge.js';
import { installShim, onPath } from './install.js';
import { deleteKey, describeStore, readKey, run, storeKey } from './keychain.js';
import type { KeyStoreDeps } from './keychain.js';
import { launch } from './launch.js';
import { showNotices } from './notices.js';
import { pathsFor } from './paths.js';
import { readSecret } from './prompt.js';
import { usageReport } from './usage.js';

const HELP = `Usage: boisestate [claude args...]
       boisestate <command>

Runs Claude Code on boisestate.ai through a local bridge. Any args that are
not a command below go to claude, so \`boisestate -c\` continues the last
session. Use \`boisestate -- <args>\` to pass args that look like a command,
such as \`boisestate -- --help\` for claude's own help.

Commands:
  login      Save your boisestate.ai API key (reads stdin when it is not a terminal)
  logout     Remove the saved key
  install    Put the boisestate command in ~/.local/bin (or the folder given)
  usage      Show this month's spend and the usage log
  status     Show where the key is saved and whether the command is installed
  bridge     Run the bridge alone in the foreground, for other clients
  help       Show this help
`;

const COMMANDS = new Set([
  'login',
  'logout',
  'install',
  'usage',
  'status',
  'bridge',
  'notices',
  'help',
]);

/** The plugin root this bundle sits in (dist/boisestate.cjs, one folder down). */
function pluginRoot(): string {
  return path.resolve(__dirname, '..');
}

async function login(deps: KeyStoreDeps): Promise<number> {
  const key = (await readSecret('boisestate.ai API key: ')).trim();
  if (key === '') {
    process.stderr.write('boisestate: no key given, nothing saved.\n');
    return 1;
  }
  storeKey(deps, key);
  process.stdout.write(`Saved the key to ${describeStore(deps)}.\n`);
  return 0;
}

/** What `boisestate status` prints. It never shows the key itself. */
function status(deps: KeyStoreDeps): string {
  const fromEnv = (deps.env['BOISESTATE_API_KEY']?.trim() ?? '') !== '';
  const key = readKey(deps);
  let where = 'not saved, run `boisestate login`';
  if (fromEnv) {
    where = 'from BOISESTATE_API_KEY';
  } else if (key !== null) {
    where = `saved in ${describeStore(deps)}`;
  }
  const dir = path.join(os.homedir(), '.local', 'bin');
  const shim = path.join(dir, 'boisestate');
  let command = 'not installed, run `boisestate install`';
  if (existsSync(shim)) {
    command = onPath(dir, deps.env['PATH']) ? shim : `${shim} (${dir} is not on your PATH)`;
  }
  return [`key: ${where}`, `command: ${command}`, `usage log: ${deps.paths.usageLog}`].join('\n');
}

async function bridge(deps: KeyStoreDeps): Promise<number> {
  const key = readKey(deps);
  const config = configFromEnv({ ...deps.env, BOISESTATE_API_KEY: key ?? '' });
  if (!config.ok) {
    process.stderr.write(`boisestate: ${config.error} Run \`boisestate login\` first.\n`);
    return 1;
  }
  const running = await startBridge({
    ...config.config,
    usageLog: deps.paths.usageLog,
    onError: (message) => {
      process.stderr.write(`boisestate bridge: ${message}\n`);
    },
    onNotice: (notice) => {
      process.stderr.write(
        `boisestate bridge: quota at ${String(notice.level)}%: $${notice.spentUsd.toFixed(2)} of $${notice.limitUsd.toFixed(2)}\n`,
      );
    },
  });
  process.stdout.write(`${JSON.stringify({ ready: true, port: running.port })}\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.stop();
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const env = process.env;
  const paths = pathsFor(env, os.homedir());
  const deps: KeyStoreDeps = { env, paths, platform: process.platform, run };
  const [first, ...rest] = argv;
  if (first === '--') {
    return runClaude(deps, rest);
  }
  if (first === '-h' || first === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === undefined || !COMMANDS.has(first)) {
    return runClaude(deps, argv);
  }
  switch (first) {
    case 'login': {
      return login(deps);
    }
    case 'logout': {
      deleteKey(deps);
      process.stdout.write('Removed the saved key.\n');
      return 0;
    }
    case 'install': {
      const dir = rest[0] ?? path.join(os.homedir(), '.local', 'bin');
      const file = installShim(dir, pluginRoot());
      process.stdout.write(`Installed ${file}\n`);
      if (!onPath(dir, env['PATH'])) {
        process.stdout.write(`${dir} is not on your PATH. Add it in your shell profile.\n`);
      }
      return 0;
    }
    case 'usage': {
      let text: string | null;
      try {
        text = readFileSync(paths.usageLog, 'utf8');
      } catch {
        text = null;
      }
      process.stdout.write(`${usageReport(text, Date.now())}\n`);
      return 0;
    }
    case 'status': {
      process.stdout.write(`${status(deps)}\n`);
      return 0;
    }
    case 'bridge': {
      return bridge(deps);
    }
    case 'notices': {
      showNotices(env['BOISESTATE_NOTICE_FILE']);
      return 0;
    }
    default: {
      process.stdout.write(HELP);
      return 0;
    }
  }
}

async function runClaude(deps: KeyStoreDeps, userArgs: readonly string[]): Promise<number> {
  const key = readKey(deps);
  if (key === null) {
    process.stderr.write(
      'boisestate: no boisestate.ai API key is saved. Run `boisestate login` first.\n',
    );
    return 1;
  }
  const config = configFromEnv({ ...deps.env, BOISESTATE_API_KEY: key });
  return launch({ env: deps.env, paths: deps.paths, config, userArgs });
}

// The bundle is CommonJS, where esbuild cannot emit top-level await.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`boisestate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
