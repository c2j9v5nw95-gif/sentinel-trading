export type RangeKey = "1h" | "24h" | "7d" | "30d" | "90d" | "1y";

export const RANGE_LABEL: Record<RangeKey, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  "1y": "1y",
};

const DAY = 24 * 60 * 60 * 1000;

export const RANGE_MS: Record<RangeKey, number> = {
  "1h": 60 * 60 * 1000,
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
  "1y": 365 * DAY,
};

export const rangeSinceISO = (r: RangeKey) =>
  new Date(Date.now() - RANGE_MS[r]).toISOString();
