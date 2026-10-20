// The boisestate.ai bridge's usage log. boisestate.ai's own usage page needs
// a signed-in browser, so the bridge appends one JSON line per finished
// call, with the backend's own token counts, and one whenever the backend
// refuses a call for the quota, which carries its own spend and limit.
// `boisestate usage` sums the log by day and model, prices it at the backend's
// rates and sets this month against the quota. Every session on the machine
// logs to the same file, so they all count.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type {
  BridgeQuota,
  BridgeUsage,
  BridgeUsageDay,
  BridgeUsageModel,
} from './bridge-usage.js';
import type { CallUsage, QuotaReport } from './upstream.js';

/** A Faculty account's monthly limit, as boisestate.ai reported it. A quota report replaces it. */
const DEFAULT_LIMIT_USD = 30;

/**
 * boisestate.ai's dollars per million tokens, input then output. Worked out
 * from its own usage page on 2026-10-17, where they reproduce every model's
 * cost to the cent.
 */
const RATES: ReadonlyMap<string, readonly [number, number]> = new Map([
  ['global.anthropic.claude-opus-5-5', [4, 20]],
  ['global.anthropic.claude-sonnet-5', [2, 10]],
]);

/** What a call cost at boisestate.ai's rates, or null for a model with no known rate. */
export function costOf(usage: CallUsage): number | null {
  const rate = RATES.get(usage.model);
  return rate === undefined
    ? null
    : (usage.inputTokens * rate[0] + usage.outputTokens * rate[1]) / 1_000_000;
}

const callSchema = z.object({
  at: z.number(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

const quotaSchema = z.object({ at: z.number(), spentUsd: z.number(), limitUsd: z.number() });

type CallLine = z.infer<typeof callSchema>;
type QuotaLine = z.infer<typeof quotaSchema>;

async function append(
  file: string,
  line: Readonly<Record<string, unknown>>,
  report: (message: string) => void,
): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(line)}\n`);
  } catch (error: unknown) {
    report(`could not log usage: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Appends one call to the log. A failure goes to report, since the call itself went fine. */
export async function logUsage(
  file: string,
  usage: CallUsage,
  at: number,
  report: (message: string) => void,
): Promise<void> {
  await append(file, { at, ...usage }, report);
}

/** Appends boisestate.ai's own spend and limit, from a refusal. */
export async function logQuota(
  file: string,
  quota: QuotaReport,
  at: number,
  report: (message: string) => void,
): Promise<void> {
  await append(file, { at, ...quota }, report);
}

/** The local calendar day of an epoch ms, as YYYY-MM-DD. */
function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The quota period of an epoch ms: its UTC month, as YYYY-MM. */
export function quotaPeriod(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function add(map: Map<string, Totals>, key: string, line: CallLine): void {
  const totals = map.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  totals.calls += 1;
  totals.inputTokens += line.inputTokens;
  totals.outputTokens += line.outputTokens;
  totals.costUsd += costOf(line) ?? 0;
  map.set(key, totals);
}

/** The log's lines it can read, in order: calls and quota reports. */
function readLines(text: string): (CallLine | QuotaLine)[] {
  const lines: (CallLine | QuotaLine)[] = [];
  for (const raw of text.split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const line = callSchema.safeParse(value);
    const quota = line.success ? null : quotaSchema.safeParse(value);
    if (line.success) {
      lines.push(line.data);
    } else if (quota?.success === true) {
      lines.push(quota.data);
    }
  }
  return lines;
}

/** This month's spend against the quota, from the last report and the calls after it. */
function quotaOf(lines: readonly (CallLine | QuotaLine)[], now: number): BridgeQuota {
  const period = quotaPeriod(now);
  let limitUsd = DEFAULT_LIMIT_USD;
  let spentUsd = 0;
  let reportedAt: number | null = null;
  for (const line of lines) {
    if ('spentUsd' in line) {
      limitUsd = line.limitUsd;
      if (quotaPeriod(line.at) === period) {
        spentUsd = line.spentUsd;
        reportedAt = line.at;
      }
    } else if (quotaPeriod(line.at) === period) {
      spentUsd += costOf(line) ?? 0;
    }
  }
  return { period, limitUsd, spentUsd, reportedAt };
}

/** Share of the quota used, in percent. */
export function quotaPercent(quota: BridgeQuota): number {
  return quota.limitUsd <= 0 ? 0 : (quota.spentUsd / quota.limitUsd) * 100;
}

/** The warning level a share has reached: 100, 80, or 0 below both. */
export function quotaLevel(percent: number): 0 | 80 | 100 {
  if (percent >= 100) {
    return 100;
  }
  return percent >= 80 ? 80 : 0;
}

/**
 * The log summed by day, oldest first, and by model, busiest first, with
 * this month's spend against the quota. Null when it has no calls and no report.
 */
export function summarizeUsage(text: string, now: number): BridgeUsage | null {
  const lines = readLines(text);
  const days = new Map<string, Totals>();
  const models = new Map<string, Totals>();
  for (const line of lines) {
    if (!('spentUsd' in line)) {
      add(days, localDay(line.at), line);
      add(models, line.model, line);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  const dayRows: BridgeUsageDay[] = [...days]
    .map(([date, totals]) => ({ date, ...totals }))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const modelRows: BridgeUsageModel[] = [...models]
    .map(([model, totals]) => ({ model, ...totals, priced: RATES.has(model) }))
    .toSorted((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return { days: dayRows, models: modelRows, quota: quotaOf(lines, now) };
}
