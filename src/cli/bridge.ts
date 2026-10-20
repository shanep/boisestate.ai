// Starts the bridge inside the launcher's own process: the loopback server,
// the usage log, and the quota watch. `boisestate` runs Claude Code against
// it, and `boisestate bridge` runs it alone for other clients.

import { readFile } from 'node:fs/promises';

import { countTokensHandler, makeAnthropicHandler, modelsHandler } from '../bridge/anthropic.js';
import type { QuotaNotice } from '../bridge/quota-watch.js';
import { QuotaWatch } from '../bridge/quota-watch.js';
import { makeOpenAiHandler } from '../bridge/openai.js';
import { BridgeServer } from '../bridge/server.js';
import type { RouteHandler } from '../bridge/server.js';
import type { UpstreamConfig } from '../bridge/upstream.js';
import { logQuota, logUsage } from '../bridge/usage-log.js';

export interface BridgeOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly host: string;
  readonly port: number;
  readonly bridgeToken: string | null;
  readonly usageLog: string;
  /** Hears a bridge error, such as a refused call or a log it could not write. */
  readonly onError: (message: string) => void;
  /** Hears that this month's spend crossed 80% or 100% of the quota. */
  readonly onNotice: (notice: QuotaNotice) => void;
}

export interface RunningBridge {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

export async function startBridge(options: BridgeOptions): Promise<RunningBridge> {
  const watch = new QuotaWatch({
    read: async (): Promise<string | null> =>
      readFile(options.usageLog, 'utf8').catch(() => null),
    now: Date.now,
    notify: options.onNotice,
  });
  // Learn where this month already stands, so only a new crossing warns.
  await watch.check();
  const upstream: UpstreamConfig = {
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    onUsage: (usage): void => {
      void logUsage(options.usageLog, usage, Date.now(), options.onError).then(async () =>
        watch.check(),
      );
    },
    onQuota: (quota): void => {
      void logQuota(options.usageLog, quota, Date.now(), options.onError).then(async () =>
        watch.check(),
      );
    },
  };
  const routes: ReadonlyMap<string, RouteHandler> = new Map([
    ['/v1/chat/completions', makeOpenAiHandler(upstream)],
    ['/v1/messages', makeAnthropicHandler(upstream)],
    ['/v1/messages/count_tokens', countTokensHandler],
  ]);
  const getRoutes: ReadonlyMap<string, RouteHandler> = new Map([['/v1/models', modelsHandler]]);
  const server = new BridgeServer({
    host: options.host,
    port: options.port,
    bridgeToken: options.bridgeToken,
    routes,
    getRoutes,
    onError: options.onError,
  });
  const port = await server.start();
  return { port, stop: async () => server.stop() };
}
