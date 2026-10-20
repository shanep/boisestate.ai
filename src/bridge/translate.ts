// The normalized request both front-end routes reduce to, and the mapping onto
// the backend's api-converse request. Centralizing it keeps the OpenAI and
// Anthropic routes honest about what the backend actually supports: no native
// tools, no images, and no sampling controls. Tools go through text instead
// (see tools.ts).

import type { ConverseMessage, ConverseRequest } from './upstream.js';

export interface NormalizedChat {
  readonly modelId: string;
  readonly messages: readonly ConverseMessage[];
  readonly systemPrompt: string | null;
  readonly maxTokens: number | null;
  readonly stream: boolean;
  /** The client's tools, whose calls the reply may hold as text. Empty for plain chat. */
  readonly toolNames: readonly string[];
}

export function toConverseRequest(chat: NormalizedChat): ConverseRequest {
  return {
    model_id: chat.modelId,
    messages: chat.messages,
    ...(chat.systemPrompt === null ? {} : { system_prompt: chat.systemPrompt }),
    ...(chat.maxTokens === null ? {} : { max_tokens: chat.maxTokens }),
  };
}

/** A rough token estimate for the count_tokens route, which has no backend. */
export function estimateTokens(chat: NormalizedChat): number {
  let characters = chat.systemPrompt?.length ?? 0;
  for (const message of chat.messages) {
    characters += message.content.length;
  }
  // About four characters per token is close enough for a context gauge.
  return Math.max(1, Math.ceil(characters / 4));
}
