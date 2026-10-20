import { describe, expect, it } from 'vitest';

import { callText, parseReply, resultText, ToolCallSplitter, toolPrompt } from './tools.js';

const KNOWN = new Set(['Read', 'Bash']);
const READ = callText('Read', { file_path: '/etc/hosts' });

describe('toolPrompt', () => {
  it('describes the protocol, then each tool with its schema', () => {
    const prompt = toolPrompt([
      { name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object' } },
    ]);
    expect(prompt).toContain('<tool_call>\n{"name": "Read"');
    expect(prompt).toContain('# Tools\n## Read\nReads a file.\nInput schema: {"type":"object"}');
  });
});

describe('callText and resultText', () => {
  it('write calls and results the way the model reads them', () => {
    expect(READ).toBe(
      '<tool_call>\n{"name":"Read","input":{"file_path":"/etc/hosts"}}\n</tool_call>',
    );
    expect(resultText('Read', 'one', false)).toBe('<tool_result name="Read">\none\n</tool_result>');
    expect(resultText('Read', 'gone', true)).toContain('\nError: gone\n');
    expect(resultText('Read', 'Error: gone', true)).toContain('\nError: gone\n');
  });
});

describe('parseReply', () => {
  it('keeps a reply with no calls as text', () => {
    expect(parseReply('Paris.', KNOWN)).toStrictEqual({ text: 'Paris.', calls: [] });
  });

  it('turns calls into tool uses, keeping the text before and dropping what follows', () => {
    const reply = parseReply(
      `Reading both.\n\n${READ}\n${callText('Bash', { command: 'ls' })}\nWaiting for results.`,
      KNOWN,
    );
    expect(reply.text).toBe('Reading both.');
    expect(reply.calls.map((call) => [call.name, call.input])).toStrictEqual([
      ['Read', { file_path: '/etc/hosts' }],
      ['Bash', { command: 'ls' }],
    ]);
    expect(reply.calls[0]?.id).toMatch(/^toolu_/u);
    expect(reply.calls[0]?.id).not.toBe(reply.calls[1]?.id);
  });

  it('takes parameters for input, and no input as empty', () => {
    const reply = parseReply(
      '<tool_call>{"name":"Bash","parameters":{"command":"ls"}}</tool_call><tool_call>{"name":"Read"}</tool_call>',
      KNOWN,
    );
    expect(reply.calls.map((call) => call.input)).toStrictEqual([{ command: 'ls' }, {}]);
  });

  it('leaves the whole reply as text when any call is not usable', () => {
    for (const bad of [
      '<tool_call>{"name": "Read", oops}</tool_call>',
      '<tool_call>{"name": "Nope", "input": {}}</tool_call>',
      '<tool_call>{"name": "Read", "input": "x"}</tool_call>',
      '<tool_call>["Read"]</tool_call>',
      `${READ}\n<tool_call>{"name": "Read", "input": {}}`,
      '<tool_call>{"name": "Read", "input": {}}',
    ]) {
      expect(parseReply(`Before ${bad}`, KNOWN)).toStrictEqual({
        text: `Before ${bad}`,
        calls: [],
      });
    }
  });
});

describe('ToolCallSplitter', () => {
  it('streams text, holding back what could start a call', () => {
    const splitter = new ToolCallSplitter(KNOWN);
    expect(splitter.push('Hello <')).toBe('Hello ');
    expect(splitter.push('b>bold</b> <tool')).toBe('<b>bold</b> ');
    expect(splitter.push('box')).toBe('<toolbox');
    expect(splitter.push(' end<')).toBe(' end');
    expect(splitter.finish()).toStrictEqual({ text: '<', calls: [] });
  });

  it('stops showing text once a call starts, and hands the calls over at the end', () => {
    const splitter = new ToolCallSplitter(KNOWN);
    const [head, tail] = [READ.slice(0, 5), READ.slice(5)];
    expect(splitter.push(`Let me look.\n${head}`)).toBe('Let me look.\n');
    expect(splitter.push(tail)).toBe('');
    expect(splitter.push('\nmore')).toBe('');
    const done = splitter.finish();
    expect(done.text).toBe('');
    expect(done.calls.map((call) => call.name)).toStrictEqual(['Read']);
  });

  it('shows a call it cannot use as text at the end', () => {
    const splitter = new ToolCallSplitter(KNOWN);
    expect(splitter.push('<tool_call>{"name": "Nope", "input": {}}</tool_call>')).toBe('');
    expect(splitter.finish()).toStrictEqual({
      text: '<tool_call>{"name": "Nope", "input": {}}</tool_call>',
      calls: [],
    });
  });
});
