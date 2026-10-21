// Runs the committed bundle against the real boisestate.ai and checks the
// replies, the way Claude Code and other clients use the bridge. It needs a key,
// from BOISESTATE_API_KEY or `boisestate login`, and each run spends a few cents
// of that key's quota. With claude on the PATH it also runs one real Claude
// Code prompt through `boisestate`, which CI requires.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'dist', 'boisestate.cjs');
const work = mkdtempSync(path.join(os.tmpdir(), 'boisestate-live-'));
const usageLog = path.join(work, 'usage.jsonl');
const env = { ...process.env, BOISESTATE_USAGE_LOG: usageLog, BRIDGE_PORT: '0' };
const inCi = process.env['CI'] === 'true';

if (inCi && (process.env['BOISESTATE_API_KEY'] ?? '').trim() === '') {
  console.error('FAIL: BOISESTATE_API_KEY is empty. Add it as a GitHub Actions secret.');
  process.exit(1);
}

let failed = 0;

async function check(name, run) {
  try {
    await run();
    console.log(`ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expect(ok, message) {
  if (!ok) {
    throw new Error(message);
  }
}

/** Starts `boisestate bridge` on a free port and resolves once it says it is ready. */
function startBridge() {
  const child = spawn(process.execPath, [bundle, 'bridge'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      reject(new Error('the bridge did not start within 15 seconds'));
    }, 15_000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const match = /"port":(\d+)/u.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ child, base: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the bridge exited with ${String(code)} before it was ready`));
    });
  });
}

let bridge;
try {
  bridge = await startBridge();
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const { child, base } = bridge;

async function post(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `HTTP ${String(response.status)}: ${text.slice(0, 300)}`);
  return text;
}

const PONG = [{ role: 'user', content: 'Reply with only the word pong.' }];

await check('GET /v1/models lists the seven models', async () => {
  const response = await fetch(`${base}/v1/models`);
  const list = await response.json();
  expect(list.data?.length === 7, `got ${JSON.stringify(list).slice(0, 300)}`);
});

await check('POST /v1/messages answers', async () => {
  const reply = JSON.parse(await post('/v1/messages', { model: 'haiku', max_tokens: 50, messages: PONG }));
  const text = reply.content?.map((block) => block.text ?? '').join('') ?? '';
  expect(/pong/iu.test(text), `got ${JSON.stringify(reply).slice(0, 300)}`);
});

await check('POST /v1/messages streams', async () => {
  const text = await post('/v1/messages', { model: 'haiku', max_tokens: 50, stream: true, messages: PONG });
  expect(/pong/iu.test(text) && text.includes('event: message_stop'), `got ${text.slice(0, 300)}`);
});

await check('POST /v1/messages calls a tool', async () => {
  const reply = JSON.parse(
    await post('/v1/messages', {
      model: 'haiku',
      max_tokens: 300,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the current weather in a city.',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
      messages: [{ role: 'user', content: 'What is the weather in Boise right now? Use the tool.' }],
    }),
  );
  const call = reply.content?.find((block) => block.type === 'tool_use');
  expect(
    reply.stop_reason === 'tool_use' && call?.name === 'get_weather' && /boise/iu.test(String(call.input?.city)),
    `got ${JSON.stringify(reply).slice(0, 300)}`,
  );
});

for (const model of ['gpt-6-luna', 'gemma-4-31b']) {
  await check(`POST /v1/chat/completions answers with ${model}`, async () => {
    const reply = JSON.parse(await post('/v1/chat/completions', { model, max_tokens: 50, messages: PONG }));
    expect(/pong/iu.test(reply.choices?.[0]?.message?.content ?? ''), `got ${JSON.stringify(reply).slice(0, 300)}`);
  });
}

await check('the usage log has a line per call', async () => {
  // The bridge writes the log after it answers, so give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let lines = [];
  try {
    lines = readFileSync(usageLog, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    // No log at all, which the check below reports.
  }
  expect(lines.length >= 5, `found ${String(lines.length)} lines in ${usageLog}`);
});

child.kill('SIGTERM');

const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (claude.status === 0) {
  await check('boisestate -p reads a file with Claude Code', async () => {
    writeFileSync(path.join(work, 'word.txt'), 'marigold\n');
    const run = spawnSync(
      process.execPath,
      [bundle, '-p', 'Read word.txt and reply with only the word in it.', '--allowedTools', 'Read'],
      { cwd: work, env, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(
      run.status === 0 && /marigold/iu.test(run.stdout),
      `exit ${String(run.status)}, stdout ${run.stdout.slice(0, 300)}, stderr ${run.stderr.slice(0, 300)}`,
    );
  });
} else if (inCi) {
  failed += 1;
  console.log('FAIL  claude is not on the PATH, so Claude Code was not tested');
} else {
  console.log('skip  claude is not on the PATH, so Claude Code was not tested');
}

rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll live checks passed.' : `\n${String(failed)} live check(s) failed.`);
process.exitCode = failed === 0 ? 0 : 1;
