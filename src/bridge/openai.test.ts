import { describe, expect, it } from 'vitest';

import { makeOpenAiHandler, parseOpenAiRequest } from './openai.js';
import {
  fakeResponder,
  jsonResponse,
  parseData,
  sseResponse,
  stubFetch,
} from './test-helpers/fixtures.js';
import type { ConverseResponse, UpstreamConfig } from './upstream.js';

const CONFIG: UpstreamConfig = {
  endpoint: 'https://up.test/api-converse',
  apiKey: 'secret-key',
  timeoutMs: 65_000,
};

function okResponse(stopReason = 'end_turn'): ConverseResponse {
  return {
    role: 'assistant',
    content: 'Hi there',
    model_id: 'global.anthropic.claude-opus-5-5',
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    stop_reason: stopReason,
    reasoning: null,
  };
}

describe('parseOpenAiRequest', () => {
  it('rejects a body with no messages', () => {
    const result = parseOpenAiRequest({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.status).toBe(400);
  });

  it('collects system and developer messages into the system prompt', () => {
    const result = parseOpenAiRequest({
      model: 'opus',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'developer', content: 'no markdown' },
        { role: 'user', content: 'hi' },
      ],
    });
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.chat.systemPrompt).toBe('be brief\n\nno markdown');
    expect(result.chat.messages).toStrictEqual([{ role: 'user', content: 'hi' }]);
    expect(result.chat.modelId).toBe('global.anthropic.claude-opus-5-5');
  });

  it('joins array text parts and reads max_completion_tokens', () => {
    const result = parseOpenAiRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
      max_completion_tokens: 128,
    });
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.chat.messages).toStrictEqual([{ role: 'user', content: 'ab' }]);
    expect(result.chat.maxTokens).toBe(128);
  });

  it('rejects an image content part', () => {
    const result = parseOpenAiRequest({
      messages: [{ role: 'user', content: [{ type: 'image_url' }] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.message).toContain('text only');
  });

  it('rejects an unsupported role', () => {
    const result = parseOpenAiRequest({ messages: [{ role: 'tool', content: 'x' }] });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.message).toContain('Unsupported role');
  });

  it('requires at least one user or assistant message', () => {
    const result = parseOpenAiRequest({ messages: [{ role: 'system', content: 'only system' }] });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.message).toContain('At least one');
  });
});

describe('makeOpenAiHandler (non-streaming)', () => {
  it('renders a chat.completion object', async () => {
    stubFetch(() => jsonResponse(200, okResponse()));
    const { responder, rec } = fakeResponder();
    await makeOpenAiHandler(CONFIG)(
      { model: 'opus', messages: [{ role: 'user', content: 'hi' }] },
      responder,
    );
    expect(rec.json[0]?.status).toBe(200);
    expect(rec.json[0]?.body).toMatchObject({
      object: 'chat.completion',
      model: 'global.anthropic.claude-opus-5-5',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });

  it('reports finish_reason length when the backend hit max_tokens', async () => {
    stubFetch(() => jsonResponse(200, okResponse('max_tokens')));
    const { responder, rec } = fakeResponder();
    await makeOpenAiHandler(CONFIG)({ messages: [{ role: 'user', content: 'hi' }] }, responder);
    expect(rec.json[0]?.body).toMatchObject({ choices: [{ finish_reason: 'length' }] });
  });

  it('returns a 400 error body for an invalid request', async () => {
    const { responder, rec } = fakeResponder();
    await makeOpenAiHandler(CONFIG)({ messages: [] }, responder);
    expect(rec.json[0]?.status).toBe(400);
    expect(rec.json[0]?.body).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('forwards an upstream error with its status', async () => {
    stubFetch(() => jsonResponse(401, { detail: 'bad key' }));
    const { responder, rec } = fakeResponder();
    await makeOpenAiHandler(CONFIG)({ messages: [{ role: 'user', content: 'hi' }] }, responder);
    expect(rec.json[0]?.status).toBe(401);
    expect(rec.json[0]?.body).toMatchObject({
      error: { message: 'bad key', type: 'authentication_error' },
    });
  });
});

describe('makeOpenAiHandler (streaming)', () => {
  it('emits an opening role chunk, content chunks, a finish chunk and [DONE]', async () => {
    stubFetch(() =>
      sseResponse([
        'event: content_block_delta\ndata: {"type":"text","text":"Hel"}',
        'event: content_block_delta\ndata: {"type":"text","text":"lo"}',
        'event: message_stop\ndata: {"stopReason":"end_turn"}',
      ]),
    );
    const { responder, rec } = fakeResponder();
    await makeOpenAiHandler(CONFIG)(
      { model: 'opus', messages: [{ role: 'user', content: 'hi' }], stream: true },
      responder,
    );
    expect(parseData(rec.events[0]?.data ?? '')).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ delta: { role: 'assistant', content: '' } }],
    });
    expect(parseData(rec.events[1]?.data ?? '')).toMatchObject({
      choices: [{ delta: { content: 'Hel' } }],
    });
    expect(parseData(rec.events[2]?.data ?? '')).toMatchObject({
      choices: [{ delta: { content: 'lo' } }],
    });
    expect(parseData(rec.events[3]?.data ?? '')).toMatchObject({
      choices: [{ finish_reason: 'stop' }],
    });
    expect(rec.events.at(-1)).toStrictEqual({ name: null, data: '[DONE]' });
    expect(rec.ended).toBe(true);
  });

  it('writes an error chunk when the upstream fails mid-stream', async () => {
    stubFetch(() => jsonResponse(403, { detail: 'no access' }));
    const { responder, rec } = fakeResponder();
    await makeOpenAiHandler(CONFIG)(
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      responder,
    );
    expect(parseData(rec.events[1]?.data ?? '')).toMatchObject({ error: { message: 'no access' } });
    expect(rec.events.at(-1)?.data).toBe('[DONE]');
  });

  it('stops pulling once the client has disconnected', async () => {
    stubFetch(() => sseResponse(['event: content_block_delta\ndata: {"type":"text","text":"x"}']));
    const { responder, rec } = fakeResponder(1);
    await makeOpenAiHandler(CONFIG)(
      { messages: [{ role: 'user', content: 'hi' }], stream: true },
      responder,
    );
    // Only the opening role chunk and the closing [DONE], no content chunk.
    expect(rec.events).toHaveLength(2);
    expect(rec.events[1]).toStrictEqual({ name: null, data: '[DONE]' });
    expect(rec.ended).toBe(true);
  });
});
