import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { noticeLine } from '../bridge/quota-watch.js';

import { installShim, pathProblem, PLUGIN_ID } from './install.js';
import type { Run, RunResult } from './keychain.js';
import { deleteKey, describeStore, readKey, storeKey } from './keychain.js';
import { claudeArgs, claudeEnv, pathWithNode } from './launch.js';
import { hookOutput } from './notices.js';
import { noticeFileFor, pathsFor } from './paths.js';
import { formatUsage, usageReport } from './usage.js';

const OK: RunResult = { status: 0, stdout: '', missing: false };

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string | undefined;
}

function fakeRun(answer: (call: Call) => RunResult): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: (command, args, input) => {
      const call = { command, args, input };
      calls.push(call);
      return answer(call);
    },
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'boisestate-cli-'));
}

describe('pathsFor', () => {
  it('uses the XDG defaults under home', () => {
    const paths = pathsFor({}, '/home/u');
    expect(paths.usageLog).toBe('/home/u/.local/state/boisestate-ai/usage.jsonl');
    expect(paths.configDir).toBe('/home/u/.config/boisestate-ai');
    expect(paths.claudeDir).toBe('/home/u/.claude');
    expect(noticeFileFor(paths, 42)).toBe('/home/u/.local/state/boisestate-ai/notices-42.jsonl');
  });

  it('follows XDG, CLAUDE_CONFIG_DIR and the usage log override', () => {
    const paths = pathsFor(
      {
        XDG_STATE_HOME: '/s',
        XDG_CONFIG_HOME: '/c',
        CLAUDE_CONFIG_DIR: '/cc',
        BOISESTATE_USAGE_LOG: '/tmp/u.jsonl',
      },
      '/home/u',
    );
    expect(paths.stateDir).toBe('/s/boisestate-ai');
    expect(paths.configDir).toBe('/c/boisestate-ai');
    expect(paths.claudeDir).toBe('/cc');
    expect(paths.usageLog).toBe('/tmp/u.jsonl');
  });
});

describe('keychain', () => {
  const paths = pathsFor({}, '/home/u');

  it('prefers BOISESTATE_API_KEY over any store', () => {
    const fake = fakeRun(() => OK);
    const key = readKey({
      env: { BOISESTATE_API_KEY: ' k1 ' },
      paths,
      platform: 'darwin',
      run: fake.run,
    });
    expect(key).toBe('k1');
    expect(fake.calls).toHaveLength(0);
  });

  it('reads and writes the macOS keychain with the key on stdin', () => {
    const fake = fakeRun((call) =>
      call.args[0] === 'find-generic-password' ? { ...OK, stdout: 'secret\n' } : OK,
    );
    const deps = { env: { USER: 'shane' }, paths, platform: 'darwin' as const, run: fake.run };
    expect(readKey(deps)).toBe('secret');
    storeKey(deps, 'a"b');
    const store = fake.calls[1];
    expect(store?.args).toStrictEqual(['-i']);
    expect(store?.input).toBe(
      'add-generic-password -U -s "boisestate.ai" -a "shane" -l "boisestate.ai API key" -w "a\\"b"\n',
    );
    expect(describeStore(deps)).toBe('the macOS login keychain');
  });

  it('treats a missing keychain item as no key', () => {
    const fake = fakeRun(() => ({ status: 44, stdout: '', missing: false }));
    expect(readKey({ env: {}, paths, platform: 'darwin', run: fake.run })).toBeNull();
  });

  it('uses secret-tool on Linux when it is installed', () => {
    const fake = fakeRun((call) =>
      call.args[0] === 'lookup' ? { ...OK, stdout: 'from-keyring' } : OK,
    );
    const deps = { env: {}, paths, platform: 'linux' as const, run: fake.run };
    expect(readKey(deps)).toBe('from-keyring');
    storeKey(deps, 'k2');
    expect(fake.calls.at(-1)).toStrictEqual({
      command: 'secret-tool',
      args: ['store', '--label=boisestate.ai API key', 'service', 'boisestate.ai'],
      input: 'k2',
    });
  });

  it('falls back to a private file on Linux without secret-tool', async () => {
    const home = await tempDir();
    const deps = {
      env: {},
      paths: pathsFor({}, home),
      platform: 'linux' as const,
      run: fakeRun(() => ({ status: null, stdout: '', missing: true })).run,
    };
    expect(readKey(deps)).toBeNull();
    storeKey(deps, 'k3');
    const file = path.join(home, '.config', 'boisestate-ai', 'api-key');
    expect(describeStore(deps)).toBe(file);
    expect(readKey(deps)).toBe('k3');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    deleteKey(deps);
    expect(readKey(deps)).toBeNull();
  });

  it('uses the file when secret-tool has no keyring to talk to', async () => {
    const home = await tempDir();
    const fake = fakeRun((call) =>
      call.args[0] === 'store' || call.args[0] === 'lookup'
        ? { status: 1, stdout: '', missing: false }
        : OK,
    );
    const deps = { env: {}, paths: pathsFor({}, home), platform: 'linux' as const, run: fake.run };
    const file = path.join(home, '.config', 'boisestate-ai', 'api-key');
    expect(storeKey(deps, 'k4')).toBe(file);
    expect(readKey(deps)).toBe('k4');
    expect(describeStore(deps)).toBe(file);
    deleteKey(deps);
    expect(readKey(deps)).toBeNull();
  });

  it('throws when the keychain refuses the key', () => {
    const fake = fakeRun(() => ({ status: 1, stdout: '', missing: false }));
    expect(() => {
      storeKey({ env: {}, paths, platform: 'darwin', run: fake.run }, 'k');
    }).toThrow(/keychain/u);
  });
});

describe('claudeArgs', () => {
  it('adds the model, no MCP, and default permissions before the user args', () => {
    expect(claudeArgs(['-c'])).toStrictEqual([
      '--model',
      'claude-opus-5-5',
      '--strict-mcp-config',
      '--permission-mode',
      'default',
      '-c',
    ]);
  });

  it('keeps a model and mode the user picked', () => {
    expect(claudeArgs(['--model', 'sonnet', '--permission-mode=plan'])).toStrictEqual([
      '--strict-mcp-config',
      '--model',
      'sonnet',
      '--permission-mode=plan',
    ]);
  });

  it('turns auto mode into default mode in either form', () => {
    expect(claudeArgs(['--permission-mode', 'auto'])).toStrictEqual([
      '--model',
      'claude-opus-5-5',
      '--strict-mcp-config',
      '--permission-mode',
      'default',
    ]);
    expect(claudeArgs(['--permission-mode=auto']).at(-1)).toBe('--permission-mode=default');
    expect(claudeArgs(['fix auto mode']).at(-1)).toBe('fix auto mode');
  });
});

describe('claudeEnv', () => {
  it('points claude at the bridge and drops real keys', () => {
    const env = claudeEnv(
      { PATH: '/bin', ANTHROPIC_API_KEY: 'real', BOISESTATE_API_KEY: 'bsu', EMPTY: undefined },
      'http://127.0.0.1:5000',
      'tok',
      '/n.jsonl',
    );
    expect(env).toStrictEqual({
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      BOISESTATE_NOTICE_FILE: '/n.jsonl',
    });
  });
});

describe('pathWithNode', () => {
  it('puts the launcher node folder first, once', () => {
    const join = (...parts: string[]): string => parts.join(path.delimiter);
    expect(pathWithNode(join('/usr/bin', '/bin'), '/n/bin')).toBe(join('/n/bin', '/usr/bin', '/bin'));
    expect(pathWithNode(join('/n/bin', '/bin'), '/n/bin')).toBe(join('/n/bin', '/bin'));
    expect(pathWithNode(undefined, '/n/bin')).toBe('/n/bin');
  });
});

describe('hookOutput', () => {
  it('turns notice lines into one systemMessage', () => {
    const text = [
      noticeLine({ level: 80, spentUsd: 24, limitUsd: 30 }),
      'junk',
      noticeLine({ level: 100, spentUsd: 30.5, limitUsd: 30 }),
      '',
    ].join('\n');
    const output: unknown = JSON.parse(hookOutput(text) ?? 'null');
    expect(output).toStrictEqual({
      systemMessage:
        "Boise State sessions have used 80% of this month's boisestate.ai quota: $24.00 of $30.00.\n" +
        'Your boisestate.ai quota is used up: $30.50 of $30.00 this month. Boise State sessions stop working until it resets at the start of next month.',
    });
  });

  it('is null for a file with no notices', () => {
    expect(hookOutput('')).toBeNull();
  });
});

describe('usage report', () => {
  it('says so when nothing is logged', () => {
    expect(usageReport(null, 0)).toMatch(/^No calls logged yet/u);
    expect(formatUsage(null)).toContain('https://boisestate.ai/settings/usage');
  });

  it('shows the month, each model and each day', () => {
    const now = new Date(2026, 9, 20, 12).getTime();
    const log = [
      { at: now - 1000, model: 'global.anthropic.claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 100_000 },
      { at: now, model: 'google.gemma-4-31b', inputTokens: 10, outputTokens: 5 },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const report = usageReport(log, now);
    expect(report).toContain('2026-10: $6.00 of $30.00 (20%), logged calls only');
    expect(report).toMatch(/global\.anthropic\.claude-opus-5-5 +1 +1,000,000 +100,000 +\$6\.00/u);
    expect(report).toMatch(/google\.gemma-4-31b .* no rate/u);
    expect(report).toMatch(/2026-10-20 +2 /u);
  });
});

describe('install', () => {
  it('checks that the command name finds the file it wrote', async () => {
    const root = await tempDir();
    const ours = path.join(root, 'ours');
    const other = path.join(root, 'other');
    const plugin = path.join(root, 'plugin', 'bin');
    for (const dir of [ours, other, plugin]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'boisestate'), '#!/bin/sh\n', { mode: 0o755 });
    }
    const file = path.join(ours, 'boisestate');
    const pathOf = (...dirs: string[]): string => dirs.join(path.delimiter);

    expect(pathProblem(file, pathOf('/x', `${ours}/`))).toBeNull();
    expect(pathProblem(file, pathOf('/x'))).toEqual({ kind: 'not-on-path', dir: ours });
    expect(pathProblem(file, undefined)).toEqual({ kind: 'not-on-path', dir: ours });
    expect(pathProblem(file, pathOf(other, ours))).toEqual({
      kind: 'shadowed',
      by: path.join(other, 'boisestate'),
    });
    expect(pathProblem(file, pathOf(ours, other))).toBeNull();
    expect(pathProblem(file, pathOf(plugin, ours), [plugin])).toBeNull();
  });

  it('writes a command that runs the installed plugin, or the fallback', async () => {
    const root = await tempDir();
    const makeBundle = async (dir: string, says: string): Promise<void> => {
      await mkdir(path.join(dir, 'dist'), { recursive: true });
      await writeFile(
        path.join(dir, 'dist', 'boisestate.cjs'),
        `process.stdout.write(${JSON.stringify(says)} + process.argv.slice(2).join(','));`,
      );
    };
    const fallback = path.join(root, 'checkout');
    const installed = path.join(root, 'cache', '0.2.0');
    await makeBundle(fallback, 'fallback:');
    await makeBundle(installed, 'installed:');
    const shim = installShim(path.join(root, 'bin'), fallback);
    expect((await stat(shim)).mode & 0o111).not.toBe(0);
    const claudeDir = path.join(root, 'claude');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir };
    expect(execFileSync(shim, ['a', 'b'], { env, encoding: 'utf8' })).toBe('fallback:a,b');

    await mkdir(path.join(claudeDir, 'plugins'), { recursive: true });
    const list = {
      version: 2,
      plugins: {
        [PLUGIN_ID]: [
          { scope: 'user', installPath: path.join(root, 'gone') },
          { scope: 'user', installPath: installed },
        ],
      },
    };
    await writeFile(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify(list));
    expect(execFileSync(shim, ['c'], { env, encoding: 'utf8' })).toBe('installed:c');
    expect(await readFile(shim, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/u);
  });
});
