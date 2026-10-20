import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  costOf,
  logQuota,
  logUsage,
  quotaLevel,
  quotaPercent,
  quotaPeriod,
  summarizeUsage,
} from './usage-log.js';

const OPUS = 'global.anthropic.claude-opus-5-5';
const SONNET = 'global.anthropic.claude-sonnet-5';
const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime();
/** A quota report line, as the bridge logs one. */
const report = (when: number, spentUsd: number, limitUsd: number): string =>
  JSON.stringify({ at: when, spentUsd, limitUsd });
const line = (when: number, model: string, inputTokens: number, outputTokens: number): string =>
  JSON.stringify({ at: when, model, inputTokens, outputTokens });

describe('logUsage', () => {
  it('appends one line per call, making the folder, and reports a failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'boisestate-usage-'));
    const file = path.join(dir, 'nested', 'usage.jsonl');
    const problems: string[] = [];
    const usage = { model: OPUS, inputTokens: 10, outputTokens: 2 };
    await logUsage(file, usage, 5, (message) => problems.push(message));
    await logUsage(file, usage, 6, (message) => problems.push(message));
    await logQuota(file, { spentUsd: 1, limitUsd: 30 }, 7, (message) => problems.push(message));
    const written = await readFile(file, 'utf8');
    expect(written.trim().split('\n')).toStrictEqual([
      JSON.stringify({ at: 5, ...usage }),
      JSON.stringify({ at: 6, ...usage }),
      JSON.stringify({ at: 7, spentUsd: 1, limitUsd: 30 }),
    ]);
    const blocked = path.join(dir, 'blocked');
    await writeFile(blocked, '');
    await logUsage(path.join(blocked, 'usage.jsonl'), usage, 7, (message) =>
      problems.push(message),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^could not log usage: /u);
  });
});

describe('costOf', () => {
  it("prices calls at boisestate.ai's rates, and knows no rate for other models", () => {
    expect(costOf({ model: OPUS, inputTokens: 1_000_000, outputTokens: 100_000 })).toBe(6);
    expect(costOf({ model: SONNET, inputTokens: 1_000_000, outputTokens: 100_000 })).toBe(3);
    expect(costOf({ model: 'google.gemma-4-31b', inputTokens: 5, outputTokens: 5 })).toBeNull();
  });
});

describe('quota levels', () => {
  it('reads the UTC month and the 80 and 100 percent marks', () => {
    expect(quotaPeriod(Date.UTC(2026, 9, 31, 23, 59))).toBe('2026-10');
    expect(quotaPeriod(Date.UTC(2026, 10, 1))).toBe('2026-11');
    expect([0, 79.9, 80, 99.9, 100, 140].map((percent) => quotaLevel(percent))).toStrictEqual([
      0, 0, 80, 80, 100, 100,
    ]);
    const quota = { period: '2026-10', limitUsd: 30, spentUsd: 24, reportedAt: null };
    expect(quotaPercent(quota)).toBe(80);
    expect(quotaPercent({ ...quota, limitUsd: 0 })).toBe(0);
  });
});

describe('summarizeUsage', () => {
  it('sums and prices calls by local day and by model, skipping lines it cannot read', () => {
    const text = [
      line(at(17, 9), OPUS, 1_000_000, 100_000),
      'not json',
      '{"at":1}',
      line(at(16, 23), 'google.gemma-4-31b', 5, 5),
      line(at(17, 10), OPUS, 500_000, 50_000),
      '',
    ].join('\n');
    expect(summarizeUsage(text, at(17, 12))).toStrictEqual({
      days: [
        { date: '2026-10-16', calls: 1, inputTokens: 5, outputTokens: 5, costUsd: 0 },
        { date: '2026-10-17', calls: 2, inputTokens: 1_500_000, outputTokens: 150_000, costUsd: 9 },
      ],
      models: [
        {
          model: OPUS,
          calls: 2,
          inputTokens: 1_500_000,
          outputTokens: 150_000,
          costUsd: 9,
          priced: true,
        },
        {
          model: 'google.gemma-4-31b',
          calls: 1,
          inputTokens: 5,
          outputTokens: 5,
          costUsd: 0,
          priced: false,
        },
      ],
      quota: { period: '2026-10', limitUsd: 30, spentUsd: 9, reportedAt: null },
    });
  });

  it("takes boisestate.ai's own figure from a report and adds the calls after it, this month only", () => {
    const text = [
      report(Date.UTC(2026, 8, 30), 50, 40),
      line(at(17, 9), OPUS, 1_000_000, 100_000),
      report(at(17, 10), 28.5, 30),
      line(at(17, 11), SONNET, 1_000_000, 100_000),
    ].join('\n');
    expect(summarizeUsage(text, at(17, 12))?.quota).toStrictEqual({
      period: '2026-10',
      limitUsd: 30,
      spentUsd: 31.5,
      reportedAt: at(17, 10),
    });
    // A new month starts from nothing, keeping the last limit it heard.
    expect(summarizeUsage(text, Date.UTC(2026, 10, 2))?.quota).toStrictEqual({
      period: '2026-11',
      limitUsd: 30,
      spentUsd: 0,
      reportedAt: null,
    });
    expect(summarizeUsage(report(at(17, 10), 30.1, 30), at(17, 12))?.days).toStrictEqual([]);
  });

  it('is null with nothing logged', () => {
    expect(summarizeUsage('', 0)).toBeNull();
    expect(summarizeUsage('garbage\n', 0)).toBeNull();
  });
});
