import { describe, expect, it } from 'vitest';

import { configFromEnv, DEFAULT_MODEL_ID } from './config.js';

describe('configFromEnv', () => {
  it('fails when the api key is missing or blank', () => {
    expect(configFromEnv({})).toStrictEqual({ ok: false, error: 'BOISESTATE_API_KEY is not set.' });
    expect(configFromEnv({ BOISESTATE_API_KEY: ' '.repeat(3) })).toStrictEqual({
      ok: false,
      error: 'BOISESTATE_API_KEY is not set.',
    });
  });

  it('fills defaults when only the api key is set', () => {
    const result = configFromEnv({ BOISESTATE_API_KEY: '  secret  ' });
    expect(result).toStrictEqual({
      ok: true,
      config: {
        endpoint: 'https://boisestate.ai/api/chat/api-converse',
        apiKey: 'secret',
        timeoutMs: 65_000,
        port: 0,
        host: '127.0.0.1',
        bridgeToken: null,
      },
    });
  });

  it('reads overrides and a bridge token', () => {
    const result = configFromEnv({
      BOISESTATE_API_KEY: 'k',
      BOISESTATE_ENDPOINT: ' https://example.test/x ',
      BOISESTATE_TIMEOUT_MS: '30000',
      BRIDGE_PORT: '8080',
      BRIDGE_HOST: '0.0.0.0',
      BRIDGE_TOKEN: ' tok ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.config).toStrictEqual({
      endpoint: 'https://example.test/x',
      apiKey: 'k',
      timeoutMs: 30_000,
      port: 8080,
      host: '0.0.0.0',
      bridgeToken: 'tok',
    });
  });

  it('falls back on blank, non-integer or out-of-range numbers', () => {
    const base = { BOISESTATE_API_KEY: 'k' };
    const timeoutOf = (raw: string): number => {
      const result = configFromEnv({ ...base, BOISESTATE_TIMEOUT_MS: raw });
      if (!result.ok) {
        throw new Error('expected ok');
      }
      return result.config.timeoutMs;
    };
    expect(timeoutOf('')).toBe(65_000);
    expect(timeoutOf('12.5')).toBe(65_000);
    expect(timeoutOf('500')).toBe(65_000); // below the 1000 minimum
    expect(timeoutOf('9999999')).toBe(65_000); // above the maximum
    expect(timeoutOf('2000')).toBe(2000);
  });

  it('treats a blank bridge token as none', () => {
    const result = configFromEnv({ BOISESTATE_API_KEY: 'k', BRIDGE_TOKEN: ' '.repeat(3) });
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.config.bridgeToken).toBeNull();
  });

  it('exposes Opus 5.5 as the default model id', () => {
    expect(DEFAULT_MODEL_ID).toBe('global.anthropic.claude-opus-5-5');
  });
});
