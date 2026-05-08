// Bybit V5 client skeleton — Phase 3 implementation lives here.
// Intentionally minimal: only the surface used by execute-entry, execute-exit,
// and protection-monitor will be filled in. Keep this file pure (no side effects).

export interface BybitConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string; // https://api.bybit.com
  recvWindow?: number;
}

export class BybitClient {
  constructor(public cfg: BybitConfig) {}

  // TODO: implement signed V5 requests, retry on 5xx/timeouts, idempotency.
  async getPosition(_symbol: string): Promise<unknown> {
    throw new Error("BybitClient.getPosition not implemented (Phase 3)");
  }
  async placeMarketOrder(_args: unknown): Promise<unknown> {
    throw new Error("BybitClient.placeMarketOrder not implemented (Phase 3)");
  }
  async setStopLoss(_args: unknown): Promise<unknown> {
    throw new Error("BybitClient.setStopLoss not implemented (Phase 3)");
  }
  async setTrailingStop(_args: unknown): Promise<unknown> {
    throw new Error("BybitClient.setTrailingStop not implemented (Phase 3)");
  }
}
