// Fails when a tracked file has an em dash or an en dash in it.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DASHES = /[\u2013\u2014]/u;
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file !== '' && !file.endsWith('package-lock.json'));
let found = false;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (DASHES.test(line)) {
      console.error(`${file}:${String(index + 1)}: use a comma, colon or new sentence instead of a dash`);
      found = true;
    }
  }
}
process.exitCode = found ? 1 : 0;
