export type RangeKey = "1h" | "24h" | "7d";

export const RANGE_LABEL: Record<RangeKey, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
};

export const RANGE_MS: Record<RangeKey, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export const rangeSinceISO = (r: RangeKey) =>
  new Date(Date.now() - RANGE_MS[r]).toISOString();
