import { describe, expect, it } from 'vitest';

import { estimateTokens, toConverseRequest } from './translate.js';
import type { NormalizedChat } from './translate.js';

function chat(overrides: Partial<NormalizedChat> = {}): NormalizedChat {
  return {
    modelId: 'global.anthropic.claude-opus-5-5',
    messages: [{ role: 'user', content: 'hello' }],
    systemPrompt: null,
    maxTokens: null,
    stream: false,
    toolNames: [],
    ...overrides,
  };
}

describe('toConverseRequest', () => {
  it('omits system_prompt and max_tokens when they are null', () => {
    expect(toConverseRequest(chat())).toStrictEqual({
      model_id: 'global.anthropic.claude-opus-5-5',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('includes system_prompt and max_tokens when present', () => {
    const request = toConverseRequest(chat({ systemPrompt: 'be brief', maxTokens: 256 }));
    expect(request).toStrictEqual({
      model_id: 'global.anthropic.claude-opus-5-5',
      messages: [{ role: 'user', content: 'hello' }],
      system_prompt: 'be brief',
      max_tokens: 256,
    });
  });
});

describe('estimateTokens', () => {
  it('never returns less than one', () => {
    expect(estimateTokens(chat({ messages: [{ role: 'user', content: '' }] }))).toBe(1);
  });

  it('counts message and system characters at four per token', () => {
    const value = estimateTokens(
      chat({ messages: [{ role: 'user', content: 'abcdefgh' }], systemPrompt: 'abcd' }),
    );
    // (8 + 4) characters / 4 = 3 tokens.
    expect(value).toBe(3);
  });
});
