// `boisestate usage`: this month's spend against the quota, then the log by
// model and by day. The figures are the bridge's own estimate. boisestate.ai's
// usage page has the real numbers but needs a signed-in browser.

import { BOISESTATE_USAGE_URL } from '../bridge/bridge-usage.js';
import type { BridgeUsage, BridgeUsageTotals } from '../bridge/bridge-usage.js';
import { quotaPercent, summarizeUsage } from '../bridge/usage-log.js';

/** How many recent days the report lists. */
const DAYS = 14;

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function tokens(value: number): string {
  return value.toLocaleString('en-US');
}

function row(label: string, totals: BridgeUsageTotals, priced = true): string {
  const cost = priced ? dollars(totals.costUsd) : 'no rate';
  return [
    label.padEnd(50),
    String(totals.calls).padStart(6),
    tokens(totals.inputTokens).padStart(14),
    tokens(totals.outputTokens).padStart(12),
    cost.padStart(9),
  ].join(' ');
}

function header(label: string): string {
  return [
    label.padEnd(50),
    'calls'.padStart(6),
    'input'.padStart(14),
    'output'.padStart(12),
    'cost'.padStart(9),
  ].join(' ');
}

export function formatUsage(usage: BridgeUsage | null): string {
  if (usage === null) {
    return `No calls logged yet. boisestate.ai's own numbers are at ${BOISESTATE_USAGE_URL}`;
  }
  const { quota } = usage;
  const percent = Math.floor(quotaPercent(quota));
  const reported =
    quota.reportedAt === null
      ? 'logged calls only'
      : `boisestate.ai's figure from ${new Date(quota.reportedAt).toLocaleString()} plus calls since`;
  const lines = [
    `${quota.period}: ${dollars(quota.spentUsd)} of ${dollars(quota.limitUsd)} (${String(percent)}%), ${reported}`,
    '',
    header('model'),
    ...usage.models.map((model) => row(model.model, model, model.priced)),
    '',
    header('day'),
    ...usage.days.slice(-DAYS).map((day) => row(day.date, day)),
    '',
    `This is an estimate from the local log. boisestate.ai's own numbers are at ${BOISESTATE_USAGE_URL}`,
  ];
  return lines.join('\n');
}

export function usageReport(logText: string | null, now: number): string {
  return formatUsage(logText === null ? null : summarizeUsage(logText, now));
}
