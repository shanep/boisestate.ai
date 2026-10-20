// Warns when this month's boisestate.ai spend crosses 80% and then 100% of
// the quota. The bridge checks after every call it logs and writes a notice
// line to the session's notice file, and the plugin's Stop hook shows it. A
// watch learns the level the month is already at when it starts, so a new
// session does not repeat a warning.

import { z } from 'zod';

import { quotaLevel, quotaPercent, summarizeUsage } from './usage-log.js';

export interface QuotaNotice {
  readonly level: 80 | 100;
  readonly spentUsd: number;
  readonly limitUsd: number;
}

const noticeSchema = z.object({
  quotaNotice: z.object({
    level: z.union([z.literal(80), z.literal(100)]),
    spentUsd: z.number(),
    limitUsd: z.number(),
  }),
});

/** The line the bridge writes for a notice. */
export function noticeLine(notice: QuotaNotice): string {
  return JSON.stringify({ quotaNotice: notice });
}

/** The notice in a notice file line, or null for any other line. */
export function parseNoticeLine(line: string): QuotaNotice | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = noticeSchema.safeParse(value);
  return parsed.success ? parsed.data.quotaNotice : null;
}

/** What the warning says. */
export function noticeText(notice: QuotaNotice): string {
  const used = `$${notice.spentUsd.toFixed(2)} of $${notice.limitUsd.toFixed(2)}`;
  if (notice.level === 100) {
    return `Your boisestate.ai quota is used up: ${used} this month. Boise State sessions stop working until it resets at the start of next month.`;
  }
  const percent = Math.floor((notice.spentUsd / notice.limitUsd) * 100);
  return `Boise State sessions have used ${String(percent)}% of this month's boisestate.ai quota: ${used}.`;
}

export interface QuotaWatchDeps {
  /** The usage log's text, or null when there is none. */
  readonly read: () => Promise<string | null>;
  readonly now: () => number;
  readonly notify: (notice: QuotaNotice) => void;
}

export class QuotaWatch {
  /** The level last seen, or null before the first check. */
  private level: 0 | 80 | 100 | null = null;
  /** The check in progress. Checks take turns, so an older read never lands after a newer one. */
  private turn: Promise<void> = Promise.resolve();

  constructor(private readonly deps: QuotaWatchDeps) {}

  /** Reads the log and notifies when the month has crossed a level since the last check. */
  async check(): Promise<void> {
    this.turn = this.turn.then(async () => this.checkNow());
    await this.turn;
  }

  private async checkNow(): Promise<void> {
    const text = await this.deps.read();
    const usage = text === null ? null : summarizeUsage(text, this.deps.now());
    // No log yet means nothing spent, so the first crossing still warns.
    const level = usage === null ? 0 : quotaLevel(quotaPercent(usage.quota));
    if (usage === null) {
      this.level = level;
      return;
    }
    const { quota } = usage;
    if (this.level !== null && level > this.level && level !== 0) {
      this.deps.notify({ level, spentUsd: quota.spentUsd, limitUsd: quota.limitUsd });
    }
    // A new month starts low again, so the next crossing warns too.
    this.level = level;
  }
}
