// The OpenAI-compatible route: POST /v1/chat/completions. It parses the chat
// request, reduces it to a NormalizedChat, and renders either a chat.completion
// object or a chat.completion.chunk SSE stream ending in [DONE]. This front-end
// is for one-shot callers that speak OpenAI; Claude Code uses the Anthropic one.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { resolveModelId } from './models.js';
import type { RouteHandler } from './server.js';
import type { NormalizedChat } from './translate.js';
import { toConverseRequest } from './translate.js';
import type { ConverseMessage, ConverseResponse, UpstreamConfig } from './upstream.js';
import { callOnce, streamUpstream } from './upstream.js';

const contentPartSchema = z.object({ type: z.string(), text: z.string().optional() });
const messageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});
const requestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
});

type FlatResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

type ChatContent = z.infer<typeof messageSchema>['content'];

function flattenContent(content: ChatContent): FlatResult {
  if (typeof content === 'string') {
    return { ok: true, text: content };
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text !== undefined) {
      parts.push(part.text);
      continue;
    }
    return {
      ok: false,
      message: `Unsupported content part "${part.type}": this backend accepts text only, no images.`,
    };
  }
  return { ok: true, text: parts.join('') };
}

type Classified =
  | { readonly kind: 'system'; readonly text: string }
  | { readonly kind: 'chat'; readonly message: ConverseMessage }
  | { readonly kind: 'error'; readonly message: string };

/** Sort one inbound message into a system prompt part, a chat turn, or an error. */
function classify(role: string, content: ChatContent): Classified {
  const flat = flattenContent(content);
  if (!flat.ok) {
    return { kind: 'error', message: flat.message };
  }
  if (role === 'system' || role === 'developer') {
    return { kind: 'system', text: flat.text };
  }
  if (role === 'user' || role === 'assistant') {
    return { kind: 'chat', message: { role, content: flat.text } };
  }
  return {
    kind: 'error',
    message: `Unsupported role "${role}": this backend accepts system, user and assistant only.`,
  };
}

export type ParseResult =
  | { readonly ok: true; readonly chat: NormalizedChat }
  | { readonly ok: false; readonly status: number; readonly message: string };

export function parseOpenAiRequest(body: unknown): ParseResult {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, message: `Invalid chat request: ${parsed.error.message}` };
  }
  const data = parsed.data;
  const systemParts: string[] = [];
  const messages: ConverseMessage[] = [];
  for (const message of data.messages) {
    const sorted = classify(message.role, message.content);
    if (sorted.kind === 'error') {
      return { ok: false, status: 400, message: sorted.message };
    }
    if (sorted.kind === 'system') {
      systemParts.push(sorted.text);
    } else {
      messages.push(sorted.message);
    }
  }
  if (messages.length === 0) {
    return {
      ok: false,
      status: 400,
      message: 'At least one user or assistant message is required.',
    };
  }
  return {
    ok: true,
    chat: {
      modelId: resolveModelId(data.model),
      messages,
      systemPrompt: systemParts.length === 0 ? null : systemParts.join('\n\n'),
      maxTokens: data.max_tokens ?? data.max_completion_tokens ?? null,
      stream: data.stream ?? false,
      toolNames: [],
    },
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function finishReason(stopReason: string): 'stop' | 'length' {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

function errorType(status: number): string {
  if (status === 401) {
    return 'authentication_error';
  }
  if (status === 400) {
    return 'invalid_request_error';
  }
  return 'api_error';
}

function errorBody(message: string, status: number): Record<string, unknown> {
  return { error: { message, type: errorType(status), code: null } };
}

function completionBody(response: ConverseResponse, model: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: response.content },
        finish_reason: finishReason(response.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.totalTokens,
    },
  };
}

interface ChunkContext {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

function chunkBody(
  context: ChunkContext,
  delta: Readonly<Record<string, unknown>>,
  finish: 'stop' | 'length' | null,
): Record<string, unknown> {
  return {
    id: context.id,
    object: 'chat.completion.chunk',
    created: context.created,
    model: context.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export function makeOpenAiHandler(config: UpstreamConfig): RouteHandler {
  return async (body, responder) => {
    const parsed = parseOpenAiRequest(body);
    if (!parsed.ok) {
      responder.json(parsed.status, errorBody(parsed.message, parsed.status));
      return;
    }
    const chat = parsed.chat;
    const request = toConverseRequest(chat);

    if (!chat.stream) {
      const result = await callOnce(config, request);
      if (result.ok) {
        responder.json(200, completionBody(result.response, chat.modelId));
      } else {
        responder.json(result.error.status, errorBody(result.error.message, result.error.status));
      }
      return;
    }

    const sse = responder.beginSse();
    const context: ChunkContext = {
      id: `chatcmpl-${randomUUID()}`,
      created: nowSeconds(),
      model: chat.modelId,
    };
    sse.send(null, JSON.stringify(chunkBody(context, { role: 'assistant', content: '' }, null)));
    for await (const event of streamUpstream(config, request)) {
      if (sse.closed) {
        break;
      }
      switch (event.kind) {
        case 'text': {
          sse.send(null, JSON.stringify(chunkBody(context, { content: event.text }, null)));
          break;
        }
        case 'stop': {
          sse.send(null, JSON.stringify(chunkBody(context, {}, finishReason(event.stopReason))));
          break;
        }
        case 'error': {
          sse.send(null, JSON.stringify(errorBody(event.error.message, event.error.status)));
          break;
        }
        case 'start':
        case 'usage':
        case 'done': {
          // These carry nothing the OpenAI stream needs.
          break;
        }
      }
    }
    sse.send(null, '[DONE]');
    sse.end();
  };
}
