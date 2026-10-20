// Calls through the boisestate.ai bridge, as `boisestate usage` shows them.
// The bridge logs each one with the backend's own token counts, priced at the
// backend's own rates, and boisestate.ai's own spend whenever it reports it.

/** Where boisestate.ai shows its own usage and quota, which only a signed-in browser can read. */
export const BOISESTATE_USAGE_URL = 'https://boisestate.ai/settings/usage';

/** Calls through the boisestate.ai bridge, by the backend's own token counts. */
export interface BridgeUsageTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Dollars at boisestate.ai's rates. Calls to a model with no known rate add nothing. */
  readonly costUsd: number;
}

export interface BridgeUsageDay extends BridgeUsageTotals {
  /** Local calendar day, YYYY-MM-DD. */
  readonly date: string;
}

export interface BridgeUsageModel extends BridgeUsageTotals {
  /** The backend's model id, such as global.anthropic.claude-opus-5-5. */
  readonly model: string;
  /** False when the bridge knows no rate for the model, so costUsd leaves it out. */
  readonly priced: boolean;
}

/** This month against the quota. boisestate.ai's quota runs by calendar month in UTC. */
export interface BridgeQuota {
  /** YYYY-MM, in UTC. */
  readonly period: string;
  readonly limitUsd: number;
  /**
   * The best estimate of this month's spend: boisestate.ai's own figure from
   * its last report, plus the logged calls since. Without a report this
   * month, only the logged calls, so web chat and older use are missing.
   */
  readonly spentUsd: number;
  /** When boisestate.ai last reported its own figure this month, or null. */
  readonly reportedAt: number | null;
}

export interface BridgeUsage {
  /** Oldest first. */
  readonly days: readonly BridgeUsageDay[];
  /** Most tokens first. */
  readonly models: readonly BridgeUsageModel[];
  readonly quota: BridgeQuota;
}
