// TestnetBybitClient — talks to Bybit V5 TESTNET via real REST.
//
// This wrapper is deliberately separate from LiveBybitClient. Testnet validates
// only BYBIT_TESTNET_* credentials and uses the testnet base URL.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { VenueBybitClient } from "./venue-client.ts";

const TESTNET_BASE = "https://api-testnet.bybit.com";

export class TestnetBybitClient extends VenueBybitClient {
  constructor(sb: SupabaseClient) {
    super(sb, {
      mode: "testnet",
      baseUrl: TESTNET_BASE,
      apiKey: Deno.env.get("BYBIT_TESTNET_API_KEY") ?? "",
      apiSecret: Deno.env.get("BYBIT_TESTNET_API_SECRET") ?? "",
    });
  }
}
