// Maps the model names front-end callers use onto the backend's model_id
// strings. A value that is already a backend model_id passes through unchanged,
// a known alias is translated, and anything else falls back to the default.

import { DEFAULT_MODEL_ID } from './config.js';

/** The seven models the api key grants, by backend model_id. */
export const MODEL_IDS = [
  'global.anthropic.claude-opus-5-5',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'global.openai.gpt-6-sol',
  'global.openai.gpt-5.6-terra',
  'global.openai.gpt-6-luna',
  'google.gemma-4-31b',
] as const;

const KNOWN: ReadonlySet<string> = new Set(MODEL_IDS);

const ALIASES: ReadonlyMap<string, string> = new Map([
  ['opus', 'global.anthropic.claude-opus-5-5'],
  ['claude-opus-5-5', 'global.anthropic.claude-opus-5-5'],
  ['sonnet', 'global.anthropic.claude-sonnet-5'],
  ['claude-sonnet-5', 'global.anthropic.claude-sonnet-5'],
  ['haiku', 'global.anthropic.claude-haiku-4-5-20251001-v1:0'],
  ['claude-haiku-4-5', 'global.anthropic.claude-haiku-4-5-20251001-v1:0'],
  ['gpt-6-sol', 'global.openai.gpt-6-sol'],
  ['gpt-5.6-terra', 'global.openai.gpt-5.6-terra'],
  ['gpt-6-luna', 'global.openai.gpt-6-luna'],
  ['gemma-4-31b', 'google.gemma-4-31b'],
]);

/**
 * Resolve a caller's model string to a backend model_id. Empty or unknown
 * names map to the default so a one-shot call never fails just for naming a
 * model this gateway does not expose.
 */
export function resolveModelId(input: string | undefined): string {
  if (input === undefined || input.trim() === '') {
    return DEFAULT_MODEL_ID;
  }
  const name = input.trim();
  if (KNOWN.has(name)) {
    return name;
  }
  return ALIASES.get(name.toLowerCase()) ?? DEFAULT_MODEL_ID;
}
