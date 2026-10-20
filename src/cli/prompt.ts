// Reads a secret without echoing it. In a terminal it reads one line in raw
// mode. Otherwise it reads all of stdin, so `pbpaste | boisestate login` works.

import process from 'node:process';

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One line typed at the terminal, echoing nothing. Ctrl-C cancels. */
async function readHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          done();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          done();
          reject(new Error('cancelled.'));
          return;
        }
        value = char === '\u007F' || char === '\b' ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on('data', onData);
  });
}

export async function readSecret(question: string): Promise<string> {
  return process.stdin.isTTY ? readHidden(question) : readAll();
}
