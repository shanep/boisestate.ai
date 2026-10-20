// Tool calling over a backend that has none. The backend only completes text,
// so the bridge describes the client's tools in the system prompt and asks the
// model to call them as <tool_call> blocks of JSON. Replies are parsed back
// into real tool_use blocks, and earlier calls and their results go to the
// backend as the same tagged text. A live run of 40 cases through
// boisestate.ai parsed every reply, with Claude Code's full prompt and tools.

import { randomUUID } from 'node:crypto';

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ParsedReply {
  /** Text for the user: the reply before its first call, or all of it. */
  readonly text: string;
  readonly calls: readonly ToolCall[];
}

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

const PROTOCOL = `# Calling tools
This connection has no native tool calling, so you call tools by writing text. To call a tool, write a block exactly like this, with one JSON object inside:
${OPEN}
{"name": "Read", "input": {"file_path": "/abs/path/file.txt"}}
${CLOSE}
- The JSON must be valid: escape quotes, backslashes and newlines inside strings.
- You can write several blocks in one reply to call tools in parallel.
- After your last block, stop. Write nothing after it, and never write a tool's result yourself.
- Results come back in the next user message as <tool_result name="..."> blocks.
- When no tool is needed, just answer in plain text with no blocks.`;

/** What the system prompt gains so the model can call tools: the protocol, then each tool. */
export function toolPrompt(tools: readonly ToolSpec[]): string {
  const listed = tools.map(
    (tool) =>
      `## ${tool.name}\n${tool.description}\nInput schema: ${JSON.stringify(tool.inputSchema)}`,
  );
  return `${PROTOCOL}\n\n# Tools\n${listed.join('\n\n')}`;
}

/** An earlier call, as the model would have written it. */
export function callText(name: string, input: unknown): string {
  return `${OPEN}\n${JSON.stringify({ name, input })}\n${CLOSE}`;
}

/** A tool's result, as the next user message carries it. */
export function resultText(name: string, content: string, isError: boolean): string {
  const body = isError && !content.startsWith('Error') ? `Error: ${content}` : content;
  return `<tool_result name="${name}">\n${body}\n</tool_result>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One block's JSON as a call to a known tool, or null. */
function readCall(body: string, known: ReadonlySet<string>): ToolCall | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value['name'] !== 'string' || !known.has(value['name'])) {
    return null;
  }
  const input = value['input'] ?? value['parameters'] ?? {};
  return isRecord(input) ? { id: `toolu_${randomUUID()}`, name: value['name'], input } : null;
}

/** The inside of each call block from at on, or null when one never closes. */
function callBodies(text: string, at: number): string[] | null {
  const bodies: string[] = [];
  for (let open = at; open !== -1;) {
    const close = text.indexOf(CLOSE, open + OPEN.length);
    const body = close === -1 ? null : text.slice(open + OPEN.length, close);
    // A block that never closes, or one with another opening inside it, is garbled.
    if (body === null || body.includes(OPEN)) {
      return null;
    }
    bodies.push(body.trim());
    open = text.indexOf(OPEN, close + CLOSE.length);
  }
  return bodies;
}

/**
 * The calls in a reply. Every block must be a valid call to a known tool, or
 * the whole reply stays text, so a garbled call reaches the user instead of
 * vanishing. Anything after the last call is dropped, as the protocol asks.
 */
export function parseReply(text: string, known: ReadonlySet<string>): ParsedReply {
  const first = text.indexOf(OPEN);
  const bodies = first === -1 ? null : callBodies(text, first);
  const calls = (bodies ?? []).map((body) => readCall(body, known));
  if (calls.length === 0 || calls.includes(null)) {
    return { text, calls: [] };
  }
  return { text: text.slice(0, first).trimEnd(), calls: calls.filter((call) => call !== null) };
}

/** How much of text's end could be the start of the open tag, so it waits for the next chunk. */
function partialOpen(text: string): number {
  for (let length = Math.min(OPEN.length - 1, text.length); length > 0; length -= 1) {
    if (OPEN.startsWith(text.slice(-length))) {
      return length;
    }
  }
  return 0;
}

/**
 * Splits a streamed reply into text the user can see at once and the calls
 * at its end. Text streams until a call starts. From there everything waits
 * for the end, since a call is only usable whole.
 */
export class ToolCallSplitter {
  private pending = '';
  private calling = false;

  constructor(private readonly known: ReadonlySet<string>) {}

  /** The text from this chunk that is safe to show now. */
  push(chunk: string): string {
    this.pending += chunk;
    if (this.calling) {
      return '';
    }
    const open = this.pending.indexOf(OPEN);
    if (open !== -1) {
      const shown = this.pending.slice(0, open);
      this.pending = this.pending.slice(open);
      this.calling = true;
      return shown;
    }
    const held = partialOpen(this.pending);
    const shown = this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(shown.length);
    return shown;
  }

  /** The text still to show and the calls, once the reply has ended. */
  finish(): ParsedReply {
    const rest = this.pending;
    this.pending = '';
    if (!this.calling) {
      return { text: rest, calls: [] };
    }
    const parsed = parseReply(rest, this.known);
    return parsed.calls.length === 0
      ? { text: rest, calls: [] }
      : { text: '', calls: parsed.calls };
  }
}
