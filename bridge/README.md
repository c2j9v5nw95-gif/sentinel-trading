# Lovable Bybit Execution Bridge

A tiny Node/Fastify service that runs on a **fixed-IP VPS** and acts as the only
hop between Supabase/Lovable edge functions and the Bybit V5 REST API.

## Why this exists

The Lovable/Supabase edge runtime egresses through CloudFront POPs that Bybit's
WAF blocks (HTTP 403 *"The Amazon CloudFront distribution is configured to
block access from your country"*). Diagnostics succeed from one POP, executor
calls fail from another — request shape, signing, and payload are identical.

Solution: move the actual signed Bybit call to a server with a stable public IP
that is registered in the Bybit API key's IP allowlist. Supabase keeps every
piece of business logic (ingest, dedupe, risk, audit, Telegram, diagnostics);
the bridge is a dumb signed-passthrough.

```
TradingView → Supabase (ingest + risk + audit + state machine)
                 │  HMAC-signed proxy call
                 ▼
            Bridge VPS (this) — fixed IP, whitelisted in Bybit
                 │  signed Bybit V5 REST
                 ▼
              api.bybit.com
```

## Recommended VPS

- **Region**: pick one that Bybit accepts and that has low latency to
  `api.bybit.com`. Good options:
  - AWS Tokyo (`ap-northeast-1`) or Singapore (`ap-southeast-1`)
  - GCP `asia-northeast1` (Tokyo)
  - Hetzner Helsinki (`hel1`) or Nuremberg (`nbg1`)
  - Vultr Tokyo / Singapore
  Avoid Cloudflare Workers, AWS Lambda, Vercel/Netlify — same edge-egress
  problem we are escaping.
- **Size**: 1 vCPU / 1 GB RAM is plenty.
- **OS**: Ubuntu 24.04 LTS.

## One-time setup

1. **Whitelist the VPS public IP** in your Bybit API key (Bybit → Account → API
   Management → Edit your live key → IP Access). The IP appears in
   `GET /v1/health` as `public_ip`.
2. **Subdomain + TLS** via Caddy (auto-Let's Encrypt). Example
   `/etc/caddy/Caddyfile`:
   ```
   bridge.yourdomain.com {
     reverse_proxy 127.0.0.1:8787
   }
   ```
3. **Generate a strong shared secret** (used by both sides):
   ```bash
   openssl rand -hex 32
   ```
   Store it on the VPS (env `BRIDGE_SECRET`) and in Lovable secrets as
   `EXECUTION_BRIDGE_SECRET`.
4. **Set Lovable secrets**:
   - `EXECUTION_BRIDGE_URL` = `https://bridge.yourdomain.com`
   - `EXECUTION_BRIDGE_SECRET` = (the hex above)

## Install on the VPS

```bash
sudo apt update && sudo apt install -y nodejs npm caddy
sudo useradd -r -m -s /usr/sbin/nologin bridge
sudo mkdir -p /opt/bridge && sudo chown bridge:bridge /opt/bridge
# scp the bridge/ directory (this folder) to /opt/bridge
sudo -u bridge npm --prefix /opt/bridge ci --omit=dev
```

Create `/etc/bridge.env` (mode 0600, owned by `bridge`):
```
PORT=8787
BRIDGE_SECRET=<openssl rand -hex 32>
BYBIT_API_BASE_URL=https://api.bybit.com
BYBIT_LIVE_API_KEY=<your bybit live key>
BYBIT_LIVE_API_SECRET=<your bybit live secret>
BRIDGE_REGION=ap-northeast-1
```

`/etc/systemd/system/bridge.service`:
```
[Unit]
Description=Lovable Bybit Execution Bridge
After=network.target

[Service]
Type=simple
User=bridge
EnvironmentFile=/etc/bridge.env
WorkingDirectory=/opt/bridge
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bridge
sudo systemctl status bridge
journalctl -u bridge -f
```

## Smoke test

From your laptop (after Lovable secrets are set, easier from the Supabase
edge — but you can also sign manually):
```bash
TS=$(date +%s%3N)
NONCE=$(uuidgen)
BODY=""
HASH=$(printf "%s" "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
SIG=$(printf "%s.%s.GET.%s.%s" "$TS" "$NONCE" "/v1/health" "$HASH" \
      | openssl dgst -sha256 -hmac "$BRIDGE_SECRET" -hex | awk '{print $2}')
curl -sS https://bridge.yourdomain.com/v1/health \
  -H "X-Bridge-Timestamp: $TS" \
  -H "X-Bridge-Nonce: $NONCE" \
  -H "X-Bridge-Signature: $SIG" | jq
```

You should see:
```json
{
  "ok": true,
  "version": "bridge-2026-05-09-v1",
  "public_ip": "203.0.113.42",
  "region": "ap-northeast-1",
  "bybit_reachable": true,
  ...
}
```

Copy `public_ip` into the Bybit API key's IP allowlist.

## Security model

- **Transport**: HTTPS only (Caddy auto-TLS).
- **Auth**: HMAC-SHA256 over `ts.nonce.method.path.sha256(body)`.
  - Timestamp skew ≤ 30 s.
  - Nonces cached 5 min (replay-safe).
- **Endpoint allowlist**: only the V5 endpoints the executor uses.
- **Idempotency**: `orderLinkId` cached 5 min; replay returns the original response.
- **Fail-fast**: no internal retry loop; transport errors surface immediately.
- **Logging**: structured JSON to journald (`journalctl -u bridge`).

## Rotation

Generate a new secret, set it in `/etc/bridge.env`, update Lovable
`EXECUTION_BRIDGE_SECRET`, then `sudo systemctl restart bridge`. Both sides
must change in the same window — keep it short.

## Troubleshooting

- **401 on every call** → secret mismatch or clock drift. Check
  `timedatectl`; bridge requires ±30 s clock skew.
- **Bybit still 403 from the bridge** → VPS public IP changed or isn't
  whitelisted. Hit `/v1/health`, copy `public_ip`, register it.
- **`bybit_reachable: false`** → check VPS outbound to `api.bybit.com`
  (firewall, IPv6 route, etc.).
