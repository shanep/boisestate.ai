// The plugin's Stop hook shows quota warnings. The bridge can't print while
// Claude Code owns the terminal, so it writes each warning to the session's
// notice file and the hook turns them into a systemMessage after each turn.

import { readFileSync, writeFileSync } from 'node:fs';

import { noticeText, parseNoticeLine } from '../bridge/quota-watch.js';

/** The hook's JSON output for a notice file's text, or null when it has no notices. */
export function hookOutput(text: string): string | null {
  const messages = text
    .split('\n')
    .map((line) => parseNoticeLine(line))
    .flatMap((notice) => (notice === null ? [] : [noticeText(notice)]));
  return messages.length === 0 ? null : JSON.stringify({ systemMessage: messages.join('\n') });
}

/** Prints the hook output for a notice file and empties it, so each warning shows once. */
export function showNotices(file: string | undefined): void {
  if (file === undefined || file === '') {
    return;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  writeFileSync(file, '');
  const output = hookOutput(text);
  if (output !== null) {
    process.stdout.write(`${output}\n`);
  }
}
