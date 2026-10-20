// The Anthropic-compatible route: POST /v1/messages, plus a count_tokens stub
// and a models list. This is the front-end Claude Code uses through
// ANTHROPIC_BASE_URL. The backend has no native tools, so the client's tools
// go through text (see tools.ts) and come back as tool_use blocks. Images and
// sampling controls are dropped because the backend does not support them.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { MODEL_IDS, resolveModelId } from './models.js';
import type { Responder, RouteHandler } from './server.js';
import type { ParsedReply, ToolCall, ToolSpec } from './tools.js';
import { callText, parseReply, resultText, ToolCallSplitter, toolPrompt } from './tools.js';
import type { NormalizedChat } from './translate.js';
import { estimateTokens, toConverseRequest } from './translate.js';
import type { ConverseMessage, ConverseResponse, UpstreamConfig } from './upstream.js';
import { callOnce, streamUpstream } from './upstream.js';

const blockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  content: z.unknown().optional(),
  // tool_use blocks
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  // tool_result blocks
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
});
// Claude Code sends a `system` role inside the messages array (a system
// reminder) alongside the top-level `system` field, so accept it here and fold
// it into the system prompt below. The backend's messages take user/assistant.
const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(blockSchema)]),
});
const systemBlockSchema = z.object({ type: z.string(), text: z.string().optional() });
// Server tools such as web search have no input schema, and the backend cannot run them.
const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
});
const requestSchema = z.object({
  tools: z.array(toolSchema).optional(),
  model: z.string().optional(),
  max_tokens: z.number().int().positive().optional(),
  messages: z.array(messageSchema).min(1),
  system: z.union([z.string(), z.array(systemBlockSchema)]).optional(),
  stream: z.boolean().optional(),
});

type MessageContent = z.infer<typeof messageSchema>['content'];
type SystemPrompt = z.infer<typeof requestSchema>['system'];

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of content as readonly unknown[]) {
    if (part !== null && typeof part === 'object' && 'text' in part) {
      const text = (part as { readonly text: unknown }).text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }
  return parts.join('');
}

type ToolNames = ReadonlyMap<string, string>;

/** Every tool_use id in the conversation with its tool's name, which a tool_result lacks. */
function toolNamesById(messages: readonly z.infer<typeof messageSchema>[]): ToolNames {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') {
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
        names.set(block.id, block.name);
      }
    }
  }
  return names;
}

/** A message's blocks as text: calls and results as the tagged text the model writes and reads. */
function flattenContent(content: MessageContent, names: ToolNames): string {
  if (typeof content === 'string') {
    return content;
  }
  let text = '';
  const tagged: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text !== undefined) {
      text += block.text;
    } else if (block.type === 'tool_use' && block.name !== undefined) {
      tagged.push(callText(block.name, block.input ?? {}));
    } else if (block.type === 'tool_result') {
      const name = names.get(block.tool_use_id ?? '') ?? 'tool';
      tagged.push(resultText(name, toolResultText(block.content), block.is_error === true));
    }
    // Image, thinking and other blocks carry nothing the backend can use.
  }
  return [text, ...tagged].filter((part) => part !== '').join('\n');
}

function toolSpecs(tools: z.infer<typeof requestSchema>['tools']): ToolSpec[] {
  return (tools ?? []).flatMap((tool) =>
    tool.input_schema === undefined
      ? []
      : [{ name: tool.name, description: tool.description ?? '', inputSchema: tool.input_schema }],
  );
}

// Claude Code starts its system prompt with this line, which Anthropic's API
// strips. boisestate.ai instead drops the whole system prompt when it starts
// with it, so the bridge strips it too.
const BILLING_LINE = /^x-anthropic-billing-header:[^\n]*\n?/u;

function flattenSystem(system: SystemPrompt): string | null {
  if (system === undefined) {
    return null;
  }
  const joined =
    typeof system === 'string'
      ? system
      : system
          .map((block) => block.text ?? '')
          .filter((text) => !BILLING_LINE.test(text))
          .join('');
  const kept = joined.replace(BILLING_LINE, '');
  return kept === '' ? null : kept;
}

export type ParseResult =
  | { readonly ok: true; readonly chat: NormalizedChat }
  | { readonly ok: false; readonly status: number; readonly message: string };

export function parseAnthropicRequest(body: unknown): ParseResult {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, message: `Invalid messages request: ${parsed.error.message}` };
  }
  const data = parsed.data;
  const messages: ConverseMessage[] = [];
  const systemParts: string[] = [];
  const topSystem = flattenSystem(data.system);
  if (topSystem !== null) {
    systemParts.push(topSystem);
  }
  const names = toolNamesById(data.messages);
  for (const message of data.messages) {
    const text = flattenContent(message.content, names);
    if (message.role === 'system') {
      if (text !== '') {
        systemParts.push(text);
      }
    } else {
      messages.push({ role: message.role, content: text });
    }
  }
  const tools = toolSpecs(data.tools);
  if (tools.length > 0) {
    systemParts.push(toolPrompt(tools));
  }
  return {
    ok: true,
    chat: {
      modelId: resolveModelId(data.model),
      messages,
      systemPrompt: systemParts.length === 0 ? null : systemParts.join('\n\n'),
      maxTokens: data.max_tokens ?? null,
      stream: data.stream ?? false,
      toolNames: tools.map((tool) => tool.name),
    },
  };
}

const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
]);

function mapStopReason(reason: string): string {
  return STOP_REASONS.has(reason) ? reason : 'end_turn';
}

function errorType(status: number): string {
  if (status === 401) {
    return 'authentication_error';
  }
  if (status === 403) {
    return 'permission_error';
  }
  if (status === 404) {
    return 'not_found_error';
  }
  if (status === 413) {
    return 'request_too_large';
  }
  if (status >= 500) {
    return 'api_error';
  }
  return 'invalid_request_error';
}

export function anthropicError(message: string, status: number): Record<string, unknown> {
  return { type: 'error', error: { type: errorType(status), message } };
}

function toolUseBlock(call: ToolCall): Record<string, unknown> {
  return { type: 'tool_use', id: call.id, name: call.name, input: call.input };
}

/** The reply's content blocks: its text, then any calls. */
function contentBlocks(reply: ParsedReply): Record<string, unknown>[] {
  const text =
    reply.text === '' && reply.calls.length > 0 ? [] : [{ type: 'text', text: reply.text }];
  return [...text, ...reply.calls.map((call) => toolUseBlock(call))];
}

export function messageBody(
  response: ConverseResponse,
  model: string,
  toolNames: readonly string[] = [],
): Record<string, unknown> {
  const reply =
    toolNames.length === 0
      ? { text: response.content, calls: [] }
      : parseReply(response.content, new Set(toolNames));
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks(reply),
    stop_reason: reply.calls.length > 0 ? 'tool_use' : mapStopReason(response.stop_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    },
  };
}

type Emit = (name: string, data: Readonly<Record<string, unknown>>) => void;

/** Each call as a tool_use block of its own after the text block, with its input in one delta. */
function emitCalls(emit: Emit, calls: readonly ToolCall[]): void {
  for (const [offset, call] of calls.entries()) {
    const index = offset + 1;
    emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { ...toolUseBlock(call), input: {} },
    });
    emit('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    });
    emit('content_block_stop', { type: 'content_block_stop', index });
  }
}

async function streamAnthropic(
  config: UpstreamConfig,
  chat: NormalizedChat,
  responder: Responder,
): Promise<void> {
  const sse = responder.beginSse();
  const id = `msg_${randomUUID()}`;
  const inputTokens = estimateTokens(chat);
  const emit: Emit = (name, data) => {
    sse.send(name, JSON.stringify(data));
  };
  emit('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: chat.modelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  emit('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  emit('ping', { type: 'ping' });

  const sendText = (text: string): void => {
    if (text !== '') {
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      });
    }
  };
  const splitter = new ToolCallSplitter(new Set(chat.toolNames));
  let stopReason = 'end_turn';
  let outputTokens: number | null = null;
  let characters = 0;
  for await (const event of streamUpstream(config, toConverseRequest(chat))) {
    if (sse.closed) {
      break;
    }
    switch (event.kind) {
      case 'text': {
        characters += event.text.length;
        sendText(chat.toolNames.length === 0 ? event.text : splitter.push(event.text));
        break;
      }
      case 'stop': {
        stopReason = mapStopReason(event.stopReason);
        break;
      }
      case 'usage': {
        outputTokens = event.usage.outputTokens;
        break;
      }
      case 'error': {
        emit('error', anthropicError(event.error.message, event.error.status));
        sse.end();
        return;
      }
      case 'start':
      case 'done': {
        // These carry nothing the Anthropic stream needs.
        break;
      }
    }
  }

  const reply = splitter.finish();
  sendText(reply.text);
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  emitCalls(emit, reply.calls);
  if (reply.calls.length > 0) {
    stopReason = 'tool_use';
  }
  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens ?? Math.max(1, Math.ceil(characters / 4)) },
  });
  emit('message_stop', { type: 'message_stop' });
  sse.end();
}

export function makeAnthropicHandler(config: UpstreamConfig): RouteHandler {
  return async (body, responder) => {
    const parsed = parseAnthropicRequest(body);
    if (!parsed.ok) {
      responder.json(parsed.status, anthropicError(parsed.message, parsed.status));
      return;
    }
    const chat = parsed.chat;
    if (chat.stream) {
      await streamAnthropic(config, chat, responder);
      return;
    }
    const result = await callOnce(config, toConverseRequest(chat));
    if (result.ok) {
      responder.json(200, messageBody(result.response, chat.modelId, chat.toolNames));
    } else {
      responder.json(
        result.error.status,
        anthropicError(result.error.message, result.error.status),
      );
    }
  };
}

/** A token counter with no backend: Claude Code uses it only for a context gauge. */
export const countTokensHandler: RouteHandler = (body, responder) => {
  const parsed = parseAnthropicRequest(body);
  responder.json(200, { input_tokens: parsed.ok ? estimateTokens(parsed.chat) : 1 });
};

/** A models list so a client probing GET /v1/models does not abort. */
export const modelsHandler: RouteHandler = (_body, responder) => {
  const data = MODEL_IDS.map((id) => ({ type: 'model', id, display_name: id }));
  responder.json(200, {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  });
};
