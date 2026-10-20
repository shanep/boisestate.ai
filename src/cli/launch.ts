// Runs Claude Code on boisestate.ai. Claude Code reads ANTHROPIC_BASE_URL
// once at startup and a plugin cannot set it, so the launcher starts the
// bridge first and then starts `claude` with its env pointed at the bridge.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';

import type { ConfigResult } from '../bridge/config.js';
import { noticeLine } from '../bridge/quota-watch.js';

import { startBridge } from './bridge.js';
import type { Env, Paths } from './paths.js';
import { noticeFileFor } from './paths.js';

/** The model bridge sessions ask for, which the bridge maps to the backend's Opus 5.5. */
const BRIDGE_MODEL = 'claude-opus-5-5';

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * The args `claude` gets: the bridge's model, no MCP servers, since the bridge
 * sends every tool's definition as text in each request, and not auto mode.
 * Auto mode's approval checks ran on Sonnet through the bridge, about six
 * 55k-token calls per turn, and used up a month's quota in under an hour.
 */
export function claudeArgs(userArgs: readonly string[]): string[] {
  const args = userArgs.map((arg, index) => {
    const previous = userArgs[index - 1];
    if (arg === '--permission-mode=auto') {
      return '--permission-mode=default';
    }
    return arg === 'auto' && previous === '--permission-mode' ? 'default' : arg;
  });
  return [
    ...(hasFlag(userArgs, '--model') ? [] : ['--model', BRIDGE_MODEL]),
    '--strict-mcp-config',
    ...(hasFlag(userArgs, '--permission-mode') ? [] : ['--permission-mode', 'default']),
    ...args,
  ];
}

/**
 * The env `claude` runs with. The token goes in ANTHROPIC_AUTH_TOKEN, a bearer
 * token, since the CLI asks the user to approve every new ANTHROPIC_API_KEY
 * and the token changes every run.
 */
export function claudeEnv(
  env: Env,
  baseUrl: string,
  token: string,
  noticeFile: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== 'ANTHROPIC_API_KEY' && name !== 'BOISESTATE_API_KEY') {
      result[name] = value;
    }
  }
  return {
    ...result,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    BOISESTATE_NOTICE_FILE: noticeFile,
  };
}

/**
 * PATH with the folder of the node running the launcher first. The plugin's
 * hook runs `node`, and an older node earlier on PATH cannot run the bundle.
 */
export function pathWithNode(pathValue: string | undefined, nodeDir: string): string {
  const entries = (pathValue ?? '').split(path.delimiter).filter((entry) => entry !== '');
  const first = entries[0] === nodeDir ? entries : [nodeDir, ...entries];
  return first.join(path.delimiter);
}

/** The exit code for a child that ended on a signal, the way a shell reports it. */
function signalCode(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

export interface LaunchOptions {
  readonly env: Env;
  readonly paths: Paths;
  readonly config: ConfigResult;
  readonly userArgs: readonly string[];
}

/** Runs `claude` on the bridge and resolves with the exit code to use. */
export async function launch(options: LaunchOptions): Promise<number> {
  const { config, paths, env } = options;
  if (!config.ok) {
    process.stderr.write(`boisestate: ${config.error}\n`);
    return 1;
  }
  mkdirSync(paths.stateDir, { recursive: true });
  const noticeFile = noticeFileFor(paths, process.pid);
  const token = randomUUID();
  const logError = (message: string): void => {
    try {
      appendFileSync(paths.bridgeLog, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Nowhere left to report it, and the session should keep going.
    }
  };
  const bridge = await startBridge({
    endpoint: config.config.endpoint,
    apiKey: config.config.apiKey,
    timeoutMs: config.config.timeoutMs,
    host: config.config.host,
    port: config.config.port,
    bridgeToken: token,
    usageLog: paths.usageLog,
    onError: logError,
    onNotice: (notice) => {
      try {
        appendFileSync(noticeFile, `${noticeLine(notice)}\n`);
      } catch (error: unknown) {
        logError(`could not save a quota notice: ${String(error)}`);
      }
    },
  });
  const baseUrl = `http://${config.config.host}:${String(bridge.port)}`;
  const child = spawn(env['BOISESTATE_CLAUDE'] ?? 'claude', claudeArgs(options.userArgs), {
    env: claudeEnv(
      { ...env, PATH: pathWithNode(env['PATH'], path.dirname(process.execPath)) },
      baseUrl,
      token,
      noticeFile,
    ),
    stdio: 'inherit',
  });
  // Ctrl-C goes to the whole foreground group, and Claude Code handles its own.
  const ignore = (): void => {
    // The child decides what Ctrl-C means.
  };
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on('SIGINT', ignore);
  process.on('SIGTERM', forward);
  process.on('SIGHUP', forward);
  const code = await new Promise<number>((resolve) => {
    child.once('error', (error: Error) => {
      const missing = 'code' in error && error.code === 'ENOENT';
      process.stderr.write(
        missing
          ? 'boisestate: could not find `claude` on your PATH.\n'
          : `boisestate: could not start claude: ${error.message}\n`,
      );
      resolve(1);
    });
    child.once('exit', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      resolve(exitCode ?? (signal === null ? 1 : signalCode(signal)));
    });
  });
  process.off('SIGINT', ignore);
  process.off('SIGTERM', forward);
  process.off('SIGHUP', forward);
  await bridge.stop();
  rmSync(noticeFile, { force: true });
  return code;
}
