// HMAC-SHA256 verification of Supabase -> bridge requests with replay protection.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";

const NONCE_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const seenNonces = new LRUCache({ max: 10_000, ttl: NONCE_TTL_MS });

export function verifyBridgeSignature({ secret, method, path, ts, nonce, signature, body }) {
  if (!ts || !nonce || !signature) return { ok: false, reason: "missing_signature_headers" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(Date.now() - tsNum) > CLOCK_SKEW_MS) return { ok: false, reason: "timestamp_skew" };
  if (seenNonces.has(nonce)) return { ok: false, reason: "replay_nonce" };

  const bodyStr = body ?? "";
  const bodyHash = createHash("sha256").update(bodyStr).digest("hex");
  const payload = `${ts}.${nonce}.${method}.${path}.${bodyHash}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(signature), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  seenNonces.set(nonce, true);
  return { ok: true };
}
