// Configuration for the bridge, read from the environment. The launcher puts
// the boisestate.ai api key there after reading it from the OS keychain, so
// it never lands in a settings file.

const DEFAULT_ENDPOINT = 'https://boisestate.ai/api/chat/api-converse';
// The backend stops a request at about 60 seconds, so allow a little past that.
const DEFAULT_TIMEOUT_MS = 65_000;
const DEFAULT_HOST = '127.0.0.1';

/** The default model when a caller names none: the most capable one tested. */
export const DEFAULT_MODEL_ID = 'global.anthropic.claude-opus-5-5';

interface BridgeConfig {
  /** Full URL of the api-converse endpoint. */
  readonly endpoint: string;
  /** The boisestate.ai API key, sent upstream as X-API-Key. */
  readonly apiKey: string;
  /** Milliseconds before an upstream request is aborted. */
  readonly timeoutMs: number;
  /** Loopback port to bind, or 0 to pick a free one. */
  readonly port: number;
  readonly host: string;
  /** A shared token a caller must present, or null to accept any loopback caller. */
  readonly bridgeToken: string | null;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: BridgeConfig }
  | { readonly ok: false; readonly error: string };

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function readString(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? '';
  return value === '' ? fallback : value;
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const apiKey = env['BOISESTATE_API_KEY']?.trim() ?? '';
  if (apiKey.length === 0) {
    return { ok: false, error: 'BOISESTATE_API_KEY is not set.' };
  }
  const token = env['BRIDGE_TOKEN']?.trim() ?? '';
  return {
    ok: true,
    config: {
      endpoint: readString(env['BOISESTATE_ENDPOINT'], DEFAULT_ENDPOINT),
      apiKey,
      timeoutMs: readInt(env['BOISESTATE_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS, 1000, 600_000),
      port: readInt(env['BRIDGE_PORT'], 0, 0, 65_535),
      host: readString(env['BRIDGE_HOST'], DEFAULT_HOST),
      bridgeToken: token === '' ? null : token,
    },
  };
}
