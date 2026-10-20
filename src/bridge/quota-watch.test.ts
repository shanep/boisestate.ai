import { describe, expect, it } from 'vitest';

import type { QuotaNotice } from './quota-watch.js';
import { noticeLine, noticeText, parseNoticeLine, QuotaWatch } from './quota-watch.js';

const OPUS = 'global.anthropic.claude-opus-5-5';
const NOW = Date.UTC(2026, 9, 17, 16);
/** A logged Opus call costing dollars, at $20 per million output tokens. */
const spend = (dollars: number): string =>
  JSON.stringify({ at: NOW, model: OPUS, inputTokens: 0, outputTokens: dollars * 50_000 });

/** Lets queued callbacks run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('notice lines', () => {
  it('round-trip, and other lines are not notices', () => {
    const notice: QuotaNotice = { level: 80, spentUsd: 24.5, limitUsd: 30 };
    expect(parseNoticeLine(noticeLine(notice))).toStrictEqual(notice);
    expect(parseNoticeLine('{"ready":true,"port":4}')).toBeNull();
    expect(parseNoticeLine('{"quotaNotice":{"level":50,"spentUsd":1,"limitUsd":2}}')).toBeNull();
    expect(parseNoticeLine('not json')).toBeNull();
  });

  it('say how much is used, and what stops at the limit', () => {
    expect(noticeText({ level: 80, spentUsd: 24.5, limitUsd: 30 })).toBe(
      "Boise State sessions have used 81% of this month's boisestate.ai quota: $24.50 of $30.00.",
    );
    expect(noticeText({ level: 100, spentUsd: 30.1, limitUsd: 30 })).toBe(
      'Your boisestate.ai quota is used up: $30.10 of $30.00 this month. Boise State sessions stop working until it resets at the start of next month.',
    );
  });
});

describe('QuotaWatch', () => {
  it('learns the level quietly, then warns once at each new crossing', async () => {
    let log: string | null = null;
    const heard: QuotaNotice[] = [];
    const watch = new QuotaWatch({
      read: async (): Promise<string | null> => {
        await Promise.resolve();
        return log;
      },
      now: (): number => NOW,
      notify: (notice): void => {
        heard.push(notice);
      },
    });
    await watch.check();
    log = spend(25);
    await watch.check();
    await watch.check();
    log = [spend(25), spend(6)].join('\n');
    await watch.check();
    expect(heard).toStrictEqual([
      { level: 80, spentUsd: 25, limitUsd: 30 },
      { level: 100, spentUsd: 31, limitUsd: 30 },
    ]);

    const late = new QuotaWatch({
      read: async (): Promise<string | null> => {
        await Promise.resolve();
        return spend(31);
      },
      now: (): number => NOW,
      notify: (notice): void => {
        heard.push(notice);
      },
    });
    await late.check();
    await late.check();
    expect(heard).toHaveLength(2);
  });

  it('takes checks in turn, so a slow older read cannot land after a newer one', async () => {
    const reads: ((text: string) => void)[] = [];
    const heard: QuotaNotice[] = [];
    const watch = new QuotaWatch({
      read: async (): Promise<string | null> =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
      now: (): number => NOW,
      notify: (notice): void => {
        heard.push(notice);
      },
    });
    const first = watch.check();
    const second = watch.check();
    await settle();
    // Only the first read has started, since the second waits its turn.
    expect(reads).toHaveLength(1);
    reads[0]?.('');
    await first;
    await settle();
    expect(reads).toHaveLength(2);
    reads[1]?.(spend(25));
    await second;
    expect(heard).toStrictEqual([{ level: 80, spentUsd: 25, limitUsd: 30 }]);
  });
});
