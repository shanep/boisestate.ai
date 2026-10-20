import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_ID } from './config.js';
import { MODEL_IDS, resolveModelId } from './models.js';

describe('resolveModelId', () => {
  it('returns the default for empty or missing input', () => {
    const missing: string | undefined = undefined;
    expect(resolveModelId(missing)).toBe(DEFAULT_MODEL_ID);
    expect(resolveModelId('')).toBe(DEFAULT_MODEL_ID);
    expect(resolveModelId(' '.repeat(3))).toBe(DEFAULT_MODEL_ID);
  });

  it('passes a known backend model id through unchanged', () => {
    for (const id of MODEL_IDS) {
      expect(resolveModelId(id)).toBe(id);
    }
  });

  it('maps friendly aliases to backend ids, ignoring case', () => {
    expect(resolveModelId('opus')).toBe('global.anthropic.claude-opus-5-5');
    expect(resolveModelId('OPUS')).toBe('global.anthropic.claude-opus-5-5');
    expect(resolveModelId('claude-sonnet-5')).toBe('global.anthropic.claude-sonnet-5');
    expect(resolveModelId('haiku')).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(resolveModelId('gpt-6-luna')).toBe('global.openai.gpt-6-luna');
    expect(resolveModelId('gemma-4-31b')).toBe('google.gemma-4-31b');
  });

  it('falls back to the default for an unknown name', () => {
    expect(resolveModelId('does-not-exist')).toBe(DEFAULT_MODEL_ID);
  });

  it('exposes exactly the seven granted models', () => {
    expect(MODEL_IDS).toHaveLength(7);
  });
});
