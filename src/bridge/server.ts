// A small loopback HTTP server for the bridge, modeled on the OTLP receiver.
// It reads and parses the JSON body, checks the optional shared token, and
// dispatches to a route handler that either answers with JSON once or switches
// the response to a Server-Sent Events stream. Every error it answers with,
// whole or mid-stream, also goes to onError, so the launcher can log it.

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { z } from 'zod';

const addressSchema = z.object({ port: z.number() });
const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

// Prompts can be very large (the backend accepts 220k+ tokens), so allow room.
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

const UNAUTHORIZED = { error: { message: 'Missing or invalid bridge token.' } } as const;
const METHOD_NOT_ALLOWED = { error: { message: 'Method not allowed.' } } as const;

/** Constant-time string compare, so a wrong token leaks no length-free timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SseWriter {
  /** Write one event. A null name writes only the data line (OpenAI style). */
  readonly send: (name: string | null, data: string) => void;
  readonly end: () => void;
  /** True once the client has gone away, so a handler can stop early. */
  readonly closed: boolean;
}

export interface Responder {
  readonly json: (status: number, body: Readonly<Record<string, unknown>>) => void;
  readonly beginSse: () => SseWriter;
}

export type RouteHandler = (body: unknown, responder: Responder) => void | Promise<void>;

export interface BridgeServerOptions {
  readonly host: string;
  readonly port: number;
  readonly bridgeToken: string | null;
  /** POST routes by path. */
  readonly routes: ReadonlyMap<string, RouteHandler>;
  /** GET routes by path, called with an undefined body. */
  readonly getRoutes?: ReadonlyMap<string, RouteHandler>;
  readonly maxBodyBytes?: number;
  readonly onError?: (message: string) => void;
  /** Listen on any free port when the requested one is taken, instead of failing. */
  readonly fallbackToAnyPort?: boolean;
}

type BodyResult =
  { readonly ok: true; readonly data: Buffer } | { readonly ok: false; readonly status: number };

async function readBody(request: http.IncomingMessage, max: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      resolve(size > max ? { ok: false, status: 413 } : { ok: true, data: Buffer.concat(chunks) });
    });
    request.on('error', () => {
      resolve({ ok: false, status: 400 });
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

/** The message in an `{ error: { message } }` body, or null for anything else. */
function errorMessageOf(value: unknown): string | null {
  const parsed = errorBodySchema.safeParse(value);
  return parsed.success ? parsed.data.error.message : null;
}

function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

class HttpResponder implements Responder {
  private sent = false;

  constructor(
    private readonly response: http.ServerResponse,
    private readonly report: (message: string) => void,
  ) {}

  json(status: number, body: Readonly<Record<string, unknown>>): void {
    // Reported before the sent check, so a throw after a stream began still shows up.
    if (status >= 400) {
      this.report(`${String(status)} ${errorMessageOf(body) ?? 'error'}`);
    }
    if (this.sent) {
      return;
    }
    this.sent = true;
    this.response.writeHead(status, { 'content-type': 'application/json' });
    this.response.end(JSON.stringify(body));
  }

  /** End the response if a handler left it open, such as a stream it threw out of. */
  close(): void {
    if (!this.response.writableEnded) {
      this.response.end();
    }
  }

  beginSse(): SseWriter {
    if (this.sent) {
      throw new Error('The response has already been sent.');
    }
    this.sent = true;
    const { response, report } = this;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let closed = false;
    response.on('close', () => {
      closed = true;
    });
    return {
      get closed(): boolean {
        return closed;
      },
      send(name: string | null, data: string): void {
        // Both routes send a stream error as `{ error: { message } }`. The cheap
        // check lets ordinary text deltas skip the parse.
        if (data.includes('"error"')) {
          const parsed = parseJson(data);
          const message = parsed.ok ? errorMessageOf(parsed.value) : null;
          if (message !== null) {
            report(`stream error: ${message}`);
          }
        }
        if (closed || response.writableEnded) {
          return;
        }
        if (name !== null) {
          response.write(`event: ${name}\n`);
        }
        response.write(`data: ${data}\n\n`);
      },
      end(): void {
        if (!response.writableEnded) {
          response.end();
        }
      },
    };
  }
}

export class BridgeServer {
  private readonly server: http.Server;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly bridgeToken: string | null;
  private readonly routes: ReadonlyMap<string, RouteHandler>;
  private readonly getRoutes: ReadonlyMap<string, RouteHandler>;
  private readonly maxBodyBytes: number;
  private readonly onError: (message: string) => void;
  private readonly fallbackToAnyPort: boolean;
  private boundPort: number | null = null;

  constructor(options: BridgeServerOptions) {
    this.host = options.host;
    this.requestedPort = options.port;
    this.bridgeToken = options.bridgeToken;
    this.routes = options.routes;
    this.getRoutes = options.getRoutes ?? new Map();
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.fallbackToAnyPort = options.fallbackToAnyPort ?? false;
    this.onError =
      options.onError ??
      ((): void => {
        // No error sink configured.
      });
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get port(): number | null {
    return this.boundPort;
  }

  async start(): Promise<number> {
    try {
      await this.listen(this.requestedPort);
    } catch (error: unknown) {
      if (!this.fallbackToAnyPort || this.requestedPort === 0 || !isAddressInUse(error)) {
        throw error;
      }
      await this.listen(0);
    }
    const { port } = addressSchema.parse(this.server.address());
    this.boundPort = port;
    return port;
  }

  private async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server.listening) {
      return;
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    this.boundPort = null;
  }

  private authorized(request: http.IncomingMessage): boolean {
    const expected = this.bridgeToken;
    if (expected === null) {
      return true;
    }
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && tokensMatch(apiKey, expected)) {
      return true;
    }
    const auth = request.headers.authorization;
    return typeof auth === 'string' && tokensMatch(auth, `Bearer ${expected}`);
  }

  private async runHandler(
    handler: RouteHandler,
    body: unknown,
    responder: HttpResponder,
  ): Promise<void> {
    try {
      await handler(body, responder);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      responder.json(500, { error: { message: `Bridge error: ${message}` } });
      responder.close();
    }
  }

  private respondNoRoute(
    pathname: string,
    otherMethod: ReadonlyMap<string, RouteHandler>,
    responder: HttpResponder,
  ): void {
    const wrongMethod = otherMethod.has(pathname);
    responder.json(wrongMethod ? 405 : 404, {
      error: { message: wrongMethod ? 'Method not allowed.' : `No route for ${pathname}.` },
    });
  }

  private async handleGet(
    request: http.IncomingMessage,
    pathname: string,
    responder: HttpResponder,
  ): Promise<void> {
    const handler = this.getRoutes.get(pathname);
    request.resume();
    if (handler === undefined) {
      this.respondNoRoute(pathname, this.routes, responder);
      return;
    }
    if (!this.authorized(request)) {
      responder.json(401, UNAUTHORIZED);
      return;
    }
    await this.runHandler(handler, undefined, responder);
  }

  private async handlePost(
    request: http.IncomingMessage,
    pathname: string,
    responder: HttpResponder,
  ): Promise<void> {
    const handler = this.routes.get(pathname);
    if (handler === undefined) {
      request.resume();
      this.respondNoRoute(pathname, this.getRoutes, responder);
      return;
    }
    if (request.method !== 'POST') {
      request.resume();
      responder.json(405, METHOD_NOT_ALLOWED);
      return;
    }
    if (!this.authorized(request)) {
      request.resume();
      responder.json(401, UNAUTHORIZED);
      return;
    }
    const body = await readBody(request, this.maxBodyBytes);
    if (!body.ok) {
      responder.json(body.status, {
        error: { message: body.status === 413 ? 'Request body too large.' : 'Bad request body.' },
      });
      return;
    }
    const json = parseJson(body.data.toString('utf8'));
    if (!json.ok) {
      responder.json(400, { error: { message: 'Request body is not valid JSON.' } });
      return;
    }
    await this.runHandler(handler, json.value, responder);
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const pathname = new URL(String(request.url), 'http://localhost').pathname;
    const responder = new HttpResponder(response, (message) => {
      this.onError(`${pathname}: ${message}`);
    });
    // Claude Code checks /api/hello when a session starts, so it gets the health answer too.
    if (pathname === '/health' || pathname === '/api/hello') {
      request.resume();
      responder.json(request.method === 'GET' ? 200 : 405, { status: 'ok' });
      return;
    }
    if (request.method === 'GET') {
      await this.handleGet(request, pathname, responder);
      return;
    }
    await this.handlePost(request, pathname, responder);
  }
}
