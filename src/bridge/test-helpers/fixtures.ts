// Test helpers for the bridge: a capturing Responder, SSE/JSON Response
// builders, and a fetch stub that records what each route sent upstream.

import { vi } from 'vitest';

import type { Responder, SseWriter } from '../server.js';

/** One captured `responder.json` call. */
interface RecordedJson {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/** One captured SSE write: a null name means the data-only (OpenAI) form. */
interface RecordedEvent {
  readonly name: string | null;
  readonly data: string;
}

interface Recording {
  readonly json: RecordedJson[];
  readonly events: RecordedEvent[];
  ended: boolean;
}

export interface FakeResponder {
  readonly responder: Responder;
  readonly rec: Recording;
}

/**
 * A Responder that records calls. `closedAfter` makes the SSE writer report
 * `closed` once that many events have been sent, to exercise early-stop paths.
 */
export function fakeResponder(closedAfter = Number.POSITIVE_INFINITY): FakeResponder {
  const rec: Recording = { json: [], events: [], ended: false };
  let sends = 0;
  const writer: SseWriter = {
    get closed(): boolean {
      return sends >= closedAfter;
    },
    send: (name: string | null, data: string): void => {
      rec.events.push({ name, data });
      sends += 1;
    },
    end: (): void => {
      rec.ended = true;
    },
  };
  const responder: Responder = {
    json: (status: number, body: Readonly<Record<string, unknown>>): void => {
      rec.json.push({ status, body });
    },
    beginSse: (): SseWriter => writer,
  };
  return { responder, rec };
}

export function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/html' } });
}

/** A streaming SSE response built from whole event blocks (no trailing blank). */
export function sseResponse(blocks: readonly string[], status = 200): Response {
  const body = blocks.map((block) => `${block}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** A response with no body, to exercise the null-stream path. */
export function nullBodyResponse(status = 200): Response {
  return new Response(null, { status });
}

export type FetchImpl = (url: string, init: RequestInit) => Response;

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export interface FetchCapture {
  readonly calls: FetchCall[];
}

/** Replace global fetch with a stub that records calls and returns `impl`. */
export function stubFetch(impl: FetchImpl): FetchCapture {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit): Response => {
      calls.push({ url, init });
      return impl(url, init);
    }),
  );
  return { calls };
}

/** An Error whose name is AbortError, as fetch throws when a request is aborted. */
export function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Parse a recorded JSON string (SSE data or request body) to a value. */
export function parseData(data: string): unknown {
  const value: unknown = JSON.parse(data);
  return value;
}

/** The parsed JSON body sent to the upstream on a given fetch call. */
export function sentBody(capture: FetchCapture, index = 0): unknown {
  const body = capture.calls[index]?.init.body;
  return parseData(typeof body === 'string' ? body : '{}');
}
