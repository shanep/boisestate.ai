// Client for the boisestate.ai api-converse backend. It builds the backend's
// custom request shape, calls it once or as a stream, and normalizes the reply
// so the OpenAI and Anthropic front-end routes share one upstream path. The
// backend is a plain completion proxy: no tools, no images, and temperature and
// top_p are rejected, so this module never sends them.

import { z } from 'zod';

/** A single turn in the backend's flattened message list. */
export interface ConverseMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** The request body the backend accepts. Only these fields are honored. */
export interface ConverseRequest {
  readonly model_id: string;
  readonly messages: readonly ConverseMessage[];
  readonly system_prompt?: string;
  readonly max_tokens?: number;
}

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheWriteInputTokens: z.number().optional(),
});

type ConverseUsage = z.infer<typeof usageSchema>;

const responseSchema = z.object({
  role: z.literal('assistant'),
  content: z.string(),
  model_id: z.string(),
  usage: usageSchema,
  stop_reason: z.string(),
  reasoning: z.string().nullable().optional(),
});

export type ConverseResponse = z.infer<typeof responseSchema>;

type UpstreamErrorCode =
  | 'auth' // 401
  | 'model_access' // 403
  | 'bad_request' // 400 or 422
  | 'quota' // 429 "Quota exceeded", sent on as 403 so clients do not retry it
  | 'timeout' // 504 or an aborted request
  | 'upstream'; // anything else

/** boisestate.ai's own spend and limit, from a request it refused for the quota. */
export interface QuotaReport {
  readonly spentUsd: number;
  readonly limitUsd: number;
}

/** A normalized upstream failure, in terms each front-end route can map. */
interface UpstreamError {
  readonly status: number;
  readonly code: UpstreamErrorCode;
  readonly message: string;
  readonly quota?: QuotaReport;
}

// The backend refuses a call over the quota with 429 and this detail.
const QUOTA_PATTERN = /^Quota exceeded: \$([\d.]+) \/ \$([\d.]+)$/u;

/**
 * A quota refusal, worded for the user. It goes on as 403 because clients
 * retry a 429 as a rate limit, and this one lasts until next month.
 */
function quotaError(detail: string): UpstreamError | null {
  const match = QUOTA_PATTERN.exec(detail.trim());
  if (match === null) {
    return null;
  }
  const quota = { spentUsd: Number(match[1]), limitUsd: Number(match[2]) };
  if (!Number.isFinite(quota.spentUsd) || !Number.isFinite(quota.limitUsd)) {
    return null;
  }
  const used = `$${quota.spentUsd.toFixed(2)} of $${quota.limitUsd.toFixed(2)}`;
  return {
    status: 403,
    code: 'quota',
    message: `Your boisestate.ai quota is used up: ${used} this month. It resets at the start of next month.`,
    quota,
  };
}

export type UpstreamResult =
  | { readonly ok: true; readonly response: ConverseResponse }
  | { readonly ok: false; readonly error: UpstreamError };

/** Normalized streaming events, the common shape both routes translate from. */
export type UpstreamEvent =
  | { readonly kind: 'start' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'stop'; readonly stopReason: string }
  | { readonly kind: 'usage'; readonly usage: ConverseUsage }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: UpstreamError };

/** What one finished call used, by the backend's own counts. */
export interface CallUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface UpstreamConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** Hears each call's usage once the backend reports it, for the usage log. */
  readonly onUsage?: (usage: CallUsage) => void;
  /** Hears boisestate.ai's own spend and limit whenever it refuses a call for the quota. */
  readonly onQuota?: (quota: QuotaReport) => void;
}

function reportUsage(config: UpstreamConfig, model: string, usage: ConverseUsage): void {
  config.onUsage?.({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
}

const deltaSchema = z.object({
  contentBlockIndex: z.number().optional(),
  type: z.string().optional(),
  text: z.string().optional(),
});

const stopEventSchema = z.object({ stopReason: z.string() });
const metadataSchema = z.object({ usage: usageSchema });

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function detailMessage(body: string): string | null {
  const value = safeJson(body);
  if (value !== null && typeof value === 'object' && 'detail' in value) {
    const detail = (value as { readonly detail: unknown }).detail;
    if (typeof detail === 'string' && detail.trim() !== '') {
      return detail;
    }
  }
  return null;
}

function codeForStatus(status: number): UpstreamErrorCode {
  if (status === 401) {
    return 'auth';
  }
  if (status === 403) {
    return 'model_access';
  }
  if (status === 400 || status === 422) {
    return 'bad_request';
  }
  if (status === 504) {
    return 'timeout';
  }
  return 'upstream';
}

function errorFromStatus(status: number, body: string): UpstreamError {
  if (status === 504) {
    return {
      status,
      code: 'timeout',
      message: 'The backend did not respond within its time limit (about 60 seconds).',
    };
  }
  const detail = detailMessage(body);
  const quota = detail === null ? null : quotaError(detail);
  if (quota !== null) {
    return quota;
  }
  const message =
    detail ?? (body.trim() === '' ? `HTTP ${String(status)}` : body.trim().slice(0, 200));
  return { status, code: codeForStatus(status), message };
}

/** The failure for a refused call, after telling onQuota about a quota refusal. */
function refused(config: UpstreamConfig, status: number, body: string): UpstreamError {
  const error = errorFromStatus(status, body);
  if (error.quota !== undefined) {
    config.onQuota?.(error.quota);
  }
  return error;
}

function abortError(error: unknown, timeoutMs: number): UpstreamError {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      status: 504,
      code: 'timeout',
      message: `The backend did not respond within ${String(Math.round(timeoutMs / 1000))} seconds.`,
    };
  }
  return {
    status: 502,
    code: 'upstream',
    message: error instanceof Error ? error.message : String(error),
  };
}

function headers(config: UpstreamConfig): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': config.apiKey };
}

/** One non-streaming completion. Never throws: failures come back as an error. */
export async function callOnce(
  config: UpstreamConfig,
  request: ConverseRequest,
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({ ...request, stream: false }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: refused(config, response.status, text) };
    }
    const parsed = responseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          status: 502,
          code: 'upstream',
          message: `Unexpected reply from api-converse: ${parsed.error.message}`,
        },
      };
    }
    reportUsage(config, parsed.data.model_id, parsed.data.usage);
    return { ok: true, response: parsed.data };
  } catch (error) {
    return { ok: false, error: abortError(error, config.timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

function mapEvent(eventName: string, data: string): UpstreamEvent | null {
  switch (eventName) {
    case 'message_start': {
      return { kind: 'start' };
    }
    case 'content_block_delta': {
      const parsed = deltaSchema.safeParse(safeJson(data));
      if (parsed.success && parsed.data.type === 'text' && parsed.data.text !== undefined) {
        return { kind: 'text', text: parsed.data.text };
      }
      return null;
    }
    case 'message_stop': {
      const parsed = stopEventSchema.safeParse(safeJson(data));
      return parsed.success ? { kind: 'stop', stopReason: parsed.data.stopReason } : null;
    }
    case 'metadata': {
      const parsed = metadataSchema.safeParse(safeJson(data));
      return parsed.success ? { kind: 'usage', usage: parsed.data.usage } : null;
    }
    case 'done': {
      return { kind: 'done' };
    }
    default: {
      // content_block_stop and anything unknown carry nothing we forward.
      return null;
    }
  }
}

/** Parse one SSE block (the text between blank lines) into an event, or null. */
export function parseSseBlock(block: string): UpstreamEvent | null {
  let eventName = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data += line.slice('data:'.length).trim();
    }
  }
  return eventName === '' ? null : mapEvent(eventName, data);
}

// A minimal view of the response body's byte stream. Response.body is typed as
// `any` here, and naming the global ReadableStream trips the Node-version lint
// rule, so the reader is described structurally and the body cast to it once.
interface ByteChunk {
  readonly done: boolean;
  readonly value?: Uint8Array;
}
interface ByteReader {
  readonly read: () => Promise<ByteChunk>;
}
interface ByteStream {
  readonly getReader: () => ByteReader;
}

type StreamStart =
  | { readonly ok: true; readonly stream: ByteStream }
  | { readonly ok: false; readonly error: UpstreamError };

/** Open the streaming request, reducing the reply to a readable body or error. */
async function startStream(
  config: UpstreamConfig,
  request: ConverseRequest,
  controller: AbortController,
): Promise<StreamStart> {
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({ ...request, stream: true }),
      signal: controller.signal,
    });
  } catch (error) {
    return { ok: false, error: abortError(error, config.timeoutMs) };
  }
  const body = response.body as ByteStream | null;
  if (!response.ok || body === null) {
    const text = body === null ? '' : await response.text();
    return { ok: false, error: refused(config, response.status, text) };
  }
  return { ok: true, stream: body };
}

/** Read an SSE body to the end, yielding each parsed event. */
async function* readStream(
  stream: ByteStream,
  config: UpstreamConfig,
): AsyncGenerator<UpstreamEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const event = parseSseBlock(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (event !== null) {
          yield event;
        }
        split = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    yield { kind: 'error', error: abortError(error, config.timeoutMs) };
    return;
  }
  const tail = parseSseBlock(buffer);
  if (tail !== null) {
    yield tail;
  }
}

/**
 * Stream a completion as normalized events. The final event is always either
 * `done` or `error`, so a consumer can stop on the first of those.
 */
export async function* streamUpstream(
  config: UpstreamConfig,
  request: ConverseRequest,
): AsyncGenerator<UpstreamEvent, void, undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);
  try {
    const started = await startStream(config, request, controller);
    if (!started.ok) {
      yield { kind: 'error', error: started.error };
      return;
    }
    for await (const event of readStream(started.stream, config)) {
      if (event.kind === 'usage') {
        reportUsage(config, request.model_id, event.usage);
      }
      yield event;
    }
  } finally {
    clearTimeout(timer);
  }
}
