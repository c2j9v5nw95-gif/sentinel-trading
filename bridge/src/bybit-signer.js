// Bybit V5 HMAC-SHA256 signer — byte-for-byte identical to the
// supabase/functions/_shared/bybit-rest.ts signer so request parity holds.
import { createHmac } from "node:crypto";

export function serializeQuery(q) {
  if (!q) return "";
  return Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function signV5({ apiKey, apiSecret, ts, recvWindow, payloadStr }) {
  const payload = ts + apiKey + recvWindow + payloadStr;
  return createHmac("sha256", apiSecret).update(payload).digest("hex");
}
