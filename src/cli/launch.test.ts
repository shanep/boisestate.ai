import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { configFromEnv } from '../bridge/config.js';

import { launch } from './launch.js';
import { pathsFor } from './paths.js';

/** A stand-in for claude that asks the bridge for its models and saves what it saw. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
http.get(process.env.ANTHROPIC_BASE_URL + '/v1/models', {
  headers: { authorization: 'Bearer ' + process.env.ANTHROPIC_AUTH_TOKEN },
}, (response) => {
  let body = '';
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => {
    fs.writeFileSync(process.env.OUT, JSON.stringify({
      args: process.argv.slice(2),
      status: response.statusCode,
      models: JSON.parse(body).data.length,
      notices: process.env.BOISESTATE_NOTICE_FILE,
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    }));
    process.exit(7);
  });
});
`;

describe('launch', () => {
  it('runs claude against a live bridge and passes its exit code back', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'boisestate-launch-'));
    const claude = path.join(dir, 'claude');
    await writeFile(claude, FAKE_CLAUDE);
    await chmod(claude, 0o755);
    const out = path.join(dir, 'out.json');
    const env = {
      ...process.env,
      BOISESTATE_CLAUDE: claude,
      OUT: out,
      XDG_STATE_HOME: dir,
      ANTHROPIC_API_KEY: 'should-not-pass',
    };
    const code = await launch({
      env,
      paths: pathsFor(env, dir),
      config: configFromEnv({ BOISESTATE_API_KEY: 'k' }),
      userArgs: ['-c'],
    });
    expect(code).toBe(7);
    const seen: unknown = JSON.parse(await readFile(out, 'utf8'));
    expect(seen).toStrictEqual({
      args: ['--model', 'claude-opus-5-5', '--strict-mcp-config', '--permission-mode', 'default', '-c'],
      status: 200,
      models: 7,
      notices: path.join(dir, 'boisestate-ai', `notices-${String(process.pid)}.jsonl`),
      apiKey: null,
    });
  });

  it('stops the bridge once claude exits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'boisestate-launch-'));
    const claude = path.join(dir, 'claude');
    await writeFile(
      claude,
      `#!/bin/sh\necho "$ANTHROPIC_BASE_URL" > "${path.join(dir, 'url')}"\n`,
    );
    await chmod(claude, 0o755);
    const env = { BOISESTATE_CLAUDE: claude, PATH: process.env['PATH'], XDG_STATE_HOME: dir };
    const code = await launch({
      env,
      paths: pathsFor(env, dir),
      config: configFromEnv({ BOISESTATE_API_KEY: 'k' }),
      userArgs: [],
    });
    expect(code).toBe(0);
    const url = (await readFile(path.join(dir, 'url'), 'utf8')).trim();
    const refused = await new Promise<boolean>((resolve) => {
      http.get(`${url}/health`, () => resolve(false)).on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it('fails without a key and starts nothing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'boisestate-launch-'));
    const code = await launch({
      env: {},
      paths: pathsFor({}, dir),
      config: configFromEnv({}),
      userArgs: [],
    });
    expect(code).toBe(1);
  });
});
