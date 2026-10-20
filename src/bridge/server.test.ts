import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeServer } from './server.js';
import type { BridgeServerOptions, RouteHandler } from './server.js';

const started: BridgeServer[] = [];

interface Running {
  readonly server: BridgeServer;
  readonly url: string;
}

function options(
  overrides: Partial<BridgeServerOptions> & { readonly routes: ReadonlyMap<string, RouteHandler> },
): BridgeServerOptions {
  return { host: '127.0.0.1', port: 0, bridgeToken: null, ...overrides };
}

async function startServer(overrides: Parameters<typeof options>[0]): Promise<Running> {
  const server = new BridgeServer(options(overrides));
  const port = await server.start();
  started.push(server);
  return { server, url: `http://127.0.0.1:${String(port)}` };
}

async function getJson(response: Response): Promise<unknown> {
  const value: unknown = JSON.parse(await response.text());
  return value;
}

async function statusOf(url: string, init?: RequestInit): Promise<number> {
  const response = await fetch(url, init);
  return response.status;
}

const echo: RouteHandler = (body, responder) => {
  responder.json(200, { got: body });
};
const list: RouteHandler = (_body, responder) => {
  responder.json(200, { models: 3 });
};
const boom: RouteHandler = () => {
  throw new Error('boom');
};
const twice: RouteHandler = (_body, responder) => {
  responder.json(200, { first: true });
  responder.json(200, { second: true });
  responder.beginSse();
};
const sseHandler: RouteHandler = (_body, responder) => {
  const sse = responder.beginSse();
  sse.send('message', 'hello');
  sse.send(null, 'raw');
  sse.end();
  sse.send(null, 'after-end');
};

const reject: RouteHandler = (_body, responder) => {
  responder.json(401, { error: { message: 'Invalid API key' } });
};
const bare: RouteHandler = (_body, responder) => {
  responder.json(502, { detail: 'no error field' });
};
const late: RouteHandler = (_body, responder) => {
  responder.beginSse().send('ping', '{}');
  throw new Error('late');
};
const failing: RouteHandler = (_body, responder) => {
  const sse = responder.beginSse();
  sse.send('content_block_delta', JSON.stringify({ text: 'say "error" twice' }));
  sse.send('delta', '{"error": not json');
  sse.send('delta', JSON.stringify({ error: 'a bare string' }));
  sse.send('error', JSON.stringify({ type: 'error', error: { message: 'timed out' } }));
  sse.end();
  sse.send(null, JSON.stringify({ error: { message: 'after end' } }));
};

describe('BridgeServer', () => {
  afterEach(async () => {
    for (const server of started.splice(0)) {
      await server.stop();
    }
  });

  describe('routing', () => {
    it('answers the health check on GET and rejects other methods', async () => {
      const { url } = await startServer({ routes: new Map() });
      const ok = await fetch(`${url}/health`);
      expect(ok.status).toBe(200);
      expect(await getJson(ok)).toStrictEqual({ status: 'ok' });
      expect(await statusOf(`${url}/health`, { method: 'POST' })).toBe(405);
    });

    it("answers Claude Code's /api/hello check without logging an error", async () => {
      const onError = vi.fn<(message: string) => void>();
      const { url } = await startServer({ routes: new Map(), onError });
      const hello = await fetch(`${url}/api/hello`);
      expect(hello.status).toBe(200);
      expect(await getJson(hello)).toStrictEqual({ status: 'ok' });
      expect(onError).not.toHaveBeenCalled();
    });

    it('dispatches a POST route with the parsed body', async () => {
      const { url } = await startServer({ routes: new Map([['/echo', echo]]) });
      const response = await fetch(`${url}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(response.status).toBe(200);
      expect(await getJson(response)).toStrictEqual({ got: { hello: 'world' } });
    });

    it('returns 404 for an unknown path and 405 for the wrong method', async () => {
      const getOnly: ReadonlyMap<string, RouteHandler> = new Map([['/models', list]]);
      const { url } = await startServer({ routes: new Map([['/echo', echo]]), getRoutes: getOnly });
      expect(await statusOf(`${url}/nope`, { method: 'POST' })).toBe(404);
      expect(await statusOf(`${url}/nope`)).toBe(404);
      // /models is GET-only, so POST is 405; /echo is POST-only, so GET is 405.
      expect(await statusOf(`${url}/models`, { method: 'POST' })).toBe(405);
      expect(await statusOf(`${url}/echo`)).toBe(405);
    });

    it('serves a GET route', async () => {
      const { url } = await startServer({
        routes: new Map(),
        getRoutes: new Map([['/models', list]]),
      });
      const response = await fetch(`${url}/models`);
      expect(await getJson(response)).toStrictEqual({ models: 3 });
    });

    it('rejects a method that is neither GET nor POST on a POST route', async () => {
      const { url } = await startServer({ routes: new Map([['/echo', echo]]) });
      expect(await statusOf(`${url}/echo`, { method: 'PUT' })).toBe(405);
    });
  });

  describe('authorization', () => {
    it('accepts a correct token via either header and rejects a missing or wrong one', async () => {
      const { url } = await startServer({
        bridgeToken: 'secret',
        routes: new Map([['/echo', echo]]),
      });
      const base = { method: 'POST', body: '{}' } as const;
      expect(await statusOf(`${url}/echo`, base)).toBe(401);
      expect(await statusOf(`${url}/echo`, { ...base, headers: { 'x-api-key': 'secret' } })).toBe(
        200,
      );
      expect(
        await statusOf(`${url}/echo`, { ...base, headers: { authorization: 'Bearer secret' } }),
      ).toBe(200);
      expect(await statusOf(`${url}/echo`, { ...base, headers: { 'x-api-key': 'wonder' } })).toBe(
        401,
      );
    });

    it('guards GET routes with the token too', async () => {
      const { url } = await startServer({
        bridgeToken: 'secret',
        routes: new Map(),
        getRoutes: new Map([['/models', list]]),
      });
      expect(await statusOf(`${url}/models`)).toBe(401);
      expect(await statusOf(`${url}/models`, { headers: { 'x-api-key': 'secret' } })).toBe(200);
    });
  });

  describe('bodies and errors', () => {
    it('rejects an oversized body with 413', async () => {
      const { url } = await startServer({ maxBodyBytes: 4, routes: new Map([['/echo', echo]]) });
      expect(await statusOf(`${url}/echo`, { method: 'POST', body: '{"a":12345}' })).toBe(413);
    });

    it('rejects an invalid JSON body with 400', async () => {
      const { url } = await startServer({ routes: new Map([['/echo', echo]]) });
      expect(await statusOf(`${url}/echo`, { method: 'POST', body: 'not json' })).toBe(400);
    });

    it('turns a handler throw into a 500 and reports it to onError', async () => {
      const onError = vi.fn<(message: string) => void>();
      const { url } = await startServer({ routes: new Map([['/x', boom]]), onError });
      const response = await fetch(`${url}/x`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(500);
      expect(await getJson(response)).toStrictEqual({ error: { message: 'Bridge error: boom' } });
      expect(onError).toHaveBeenCalledExactlyOnceWith('/x: 500 Bridge error: boom');
    });

    it('reports every error response with its path, status and message', async () => {
      const onError = vi.fn<(message: string) => void>();
      const { url } = await startServer({
        routes: new Map([
          ['/echo', echo],
          ['/reject', reject],
          ['/bare', bare],
        ]),
        onError,
      });
      await fetch(`${url}/echo`, { method: 'POST', body: '{}' });
      expect(onError).not.toHaveBeenCalled();
      await fetch(`${url}/reject`, { method: 'POST', body: '{}' });
      await fetch(`${url}/bare`, { method: 'POST', body: '{}' });
      await fetch(`${url}/missing`, { method: 'POST', body: '{}' });
      expect(onError.mock.calls).toStrictEqual([
        ['/reject: 401 Invalid API key'],
        ['/bare: 502 error'],
        ['/missing: 404 No route for /missing.'],
      ]);
    });

    it('reports a handler throw after the stream began', async () => {
      const onError = vi.fn<(message: string) => void>();
      const { url } = await startServer({ routes: new Map([['/late', late]]), onError });
      const response = await fetch(`${url}/late`, { method: 'POST', body: '{}' });
      await response.text();
      expect(onError).toHaveBeenCalledWith('/late: 500 Bridge error: late');
    });

    it('still answers 500 when no error sink is configured', async () => {
      const { url } = await startServer({ routes: new Map([['/x', boom]]) });
      expect(await statusOf(`${url}/x`, { method: 'POST', body: '{}' })).toBe(500);
    });

    it('ignores a second json call and a beginSse after the response is sent', async () => {
      const { url } = await startServer({ routes: new Map([['/x', twice]]) });
      const response = await fetch(`${url}/x`, { method: 'POST', body: '{}' });
      expect(await getJson(response)).toStrictEqual({ first: true });
    });
  });

  describe('streaming', () => {
    it('writes named and data-only SSE events and stops after end', async () => {
      const { url } = await startServer({ routes: new Map([['/stream', sseHandler]]) });
      const response = await fetch(`${url}/stream`, { method: 'POST', body: '{}' });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const text = await response.text();
      expect(text).toContain('event: message\ndata: hello\n\n');
      expect(text).toContain('data: raw\n\n');
      expect(text).not.toContain('after-end');
    });

    it('reports stream error events and nothing else', async () => {
      const onError = vi.fn<(message: string) => void>();
      const { url } = await startServer({ routes: new Map([['/s', failing]]), onError });
      const response = await fetch(`${url}/s`, { method: 'POST', body: '{}' });
      const text = await response.text();
      expect(text).toContain('event: error\n');
      expect(text).not.toContain('after end');
      expect(onError.mock.calls).toStrictEqual([
        ['/s: stream error: timed out'],
        ['/s: stream error: after end'],
      ]);
    });
  });

  describe('lifecycle', () => {
    it('tracks the bound port and clears it on stop', async () => {
      const server = new BridgeServer(options({ routes: new Map() }));
      expect(server.port).toBeNull();
      const port = await server.start();
      expect(server.port).toBe(port);
      await server.stop();
      expect(server.port).toBeNull();
      // A second stop on an already-stopped server is a no-op.
      await server.stop();
    });

    it('rejects start when the port is already in use', async () => {
      const { server } = await startServer({ routes: new Map() });
      const port = server.port ?? 0;
      const clash = new BridgeServer(options({ port, routes: new Map() }));
      started.push(clash);
      await expect(clash.start()).rejects.toThrow();
    });

    it('takes any free port when asked to and the requested one is taken', async () => {
      const { server } = await startServer({ routes: new Map() });
      const port = server.port ?? 0;
      const clash = new BridgeServer(options({ port, routes: new Map(), fallbackToAnyPort: true }));
      started.push(clash);
      const bound = await clash.start();
      expect(bound).not.toBe(port);
      expect(clash.port).toBe(bound);
    });

    it('still fails on a bad host with the fallback on', async () => {
      const bad = new BridgeServer(
        options({ host: '203.0.113.1', port: 1, routes: new Map(), fallbackToAnyPort: true }),
      );
      await expect(bad.start()).rejects.toThrow();
    });
  });
});
