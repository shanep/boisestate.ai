// Stores the boisestate.ai api key outside any settings file. macOS uses the
// login keychain through `security`, Linux uses the Secret Service through
// `secret-tool`, and a Linux box without secret-tool, or with one that has no
// keyring running (WSL, ssh), gets a file only the user can read. BOISESTATE_API_KEY in the environment wins over all of them.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Env, Paths } from './paths.js';

const SERVICE = 'boisestate.ai';
const LABEL = 'boisestate.ai API key';

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  /** True when the program is not installed. */
  readonly missing: boolean;
}

/** Runs a program with optional stdin and returns what it printed. */
export type Run = (command: string, args: readonly string[], input?: string) => RunResult;

export const run: Run = (command, args, input) => {
  const result = spawnSync(command, args, {
    input: input ?? '',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const missing =
    result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT';
  return { status: result.status, stdout: result.stdout, missing };
};

export interface KeyStoreDeps {
  readonly env: Env;
  readonly paths: Paths;
  readonly platform: NodeJS.Platform;
  readonly run: Run;
}

type Backend = 'keychain' | 'secret-tool' | 'file';

function account(env: Env): string {
  return env['USER'] ?? env['LOGNAME'] ?? 'boisestate';
}

function keyFile(paths: Paths): string {
  return path.join(paths.configDir, 'api-key');
}

function readKeyFile(paths: Paths): string {
  try {
    return readFileSync(keyFile(paths), 'utf8');
  } catch {
    return '';
  }
}

function writeKeyFile(paths: Paths, key: string): void {
  const file = keyFile(paths);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  // writeFileSync only applies the mode to a new file.
  chmodSync(file, 0o600);
}

function backendFor(deps: KeyStoreDeps): Backend {
  if (deps.platform === 'darwin') {
    return 'keychain';
  }
  return deps.run('secret-tool', ['--version']).missing ? 'file' : 'secret-tool';
}

/** Quotes a value for `security -i`, which splits its input line like a shell. */
function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`)}"`;
}

/** Where the key lives, in words, for `boisestate login` to report. */
export function describeStore(deps: KeyStoreDeps): string {
  switch (backendFor(deps)) {
    case 'keychain': {
      return 'the macOS login keychain';
    }
    case 'secret-tool': {
      return existsSync(keyFile(deps.paths)) ? keyFile(deps.paths) : 'the Secret Service keyring';
    }
    case 'file': {
      return keyFile(deps.paths);
    }
  }
}

/** The api key, or null when none is set anywhere. */
export function readKey(deps: KeyStoreDeps): string | null {
  const fromEnv = deps.env['BOISESTATE_API_KEY']?.trim() ?? '';
  if (fromEnv !== '') {
    return fromEnv;
  }
  let stored = '';
  switch (backendFor(deps)) {
    case 'keychain': {
      const result = deps.run('security', [
        'find-generic-password',
        '-s',
        SERVICE,
        '-a',
        account(deps.env),
        '-w',
      ]);
      stored = result.status === 0 ? result.stdout : '';
      break;
    }
    case 'secret-tool': {
      const result = deps.run('secret-tool', ['lookup', 'service', SERVICE]);
      stored = result.status === 0 ? result.stdout : '';
      if (stored.trim() === '') {
        stored = readKeyFile(deps.paths);
      }
      break;
    }
    case 'file': {
      stored = readKeyFile(deps.paths);
      break;
    }
  }
  const key = stored.trim();
  return key === '' ? null : key;
}

/**
 * Saves the key and returns where it went, in words. The key goes to `security`
 * and `secret-tool` on stdin, so it never shows up in another user's `ps`.
 */
export function storeKey(deps: KeyStoreDeps, key: string): string {
  switch (backendFor(deps)) {
    case 'keychain': {
      const line = [
        'add-generic-password',
        '-U',
        '-s',
        quoted(SERVICE),
        '-a',
        quoted(account(deps.env)),
        '-l',
        quoted(LABEL),
        '-w',
        quoted(key),
      ].join(' ');
      const result = deps.run('security', ['-i'], `${line}\n`);
      if (result.status !== 0) {
        throw new Error('security could not save the key to the keychain.');
      }
      return describeStore(deps);
    }
    case 'secret-tool': {
      const result = deps.run(
        'secret-tool',
        ['store', `--label=${LABEL}`, 'service', SERVICE],
        key,
      );
      if (result.status !== 0) {
        // secret-tool is there but no keyring answered, so use the file.
        writeKeyFile(deps.paths, key);
        return keyFile(deps.paths);
      }
      rmSync(keyFile(deps.paths), { force: true });
      return 'the Secret Service keyring';
    }
    case 'file': {
      writeKeyFile(deps.paths, key);
      return keyFile(deps.paths);
    }
  }
}

/** Removes a saved key. Removing one that is not there is fine. */
export function deleteKey(deps: KeyStoreDeps): void {
  switch (backendFor(deps)) {
    case 'keychain': {
      deps.run('security', ['delete-generic-password', '-s', SERVICE, '-a', account(deps.env)]);
      return;
    }
    case 'secret-tool': {
      deps.run('secret-tool', ['clear', 'service', SERVICE]);
      rmSync(keyFile(deps.paths), { force: true });
      return;
    }
    case 'file': {
      rmSync(keyFile(deps.paths), { force: true });
      return;
    }
  }
}
