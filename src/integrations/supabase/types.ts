export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      analytics_snapshot_runs: {
        Row: {
          api_calls: number
          errors: Json
          finished_at: string | null
          id: string
          ok: boolean
          rows_written: number
          started_at: string
          symbols_processed: number
          writer: string
        }
        Insert: {
          api_calls?: number
          errors?: Json
          finished_at?: string | null
          id?: string
          ok?: boolean
          rows_written?: number
          started_at?: string
          symbols_processed?: number
          writer: string
        }
        Update: {
          api_calls?: number
          errors?: Json
          finished_at?: string | null
          id?: string
          ok?: boolean
          rows_written?: number
          started_at?: string
          symbols_processed?: number
          writer?: string
        }
        Relationships: []
      }
      analytics_tf_context_map: {
        Row: {
          context_timeframe: string
          created_at: string
          enabled: boolean
          id: string
          priority: number
          trade_timeframe: string
          updated_at: string
        }
        Insert: {
          context_timeframe: string
          created_at?: string
          enabled?: boolean
          id?: string
          priority?: number
          trade_timeframe: string
          updated_at?: string
        }
        Update: {
          context_timeframe?: string
          created_at?: string
          enabled?: boolean
          id?: string
          priority?: number
          trade_timeframe?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          auto_pause_on_critical_invariant: boolean
          auto_snapshot_signal_context_enabled: boolean
          chaos_config: Json
          created_at: string
          dedupe_window_seconds: number
          default_leverage: number
          email_ingest_enabled: boolean
          emergency_stop: boolean
          emergency_stop_blocks_exits: boolean
          entries_paused: boolean
          id: string
          live_confirmation_phrase: string | null
          live_enabled: boolean
          live_risk_acknowledged_at: string | null
          live_risk_acknowledged_by: string | null
          live_risk_halt_metrics: Json | null
          live_risk_halt_reason: string | null
          live_risk_halted: boolean
          live_risk_halted_at: string | null
          live_risk_max_consecutive_losses: number
          live_risk_max_daily_loss_pct: number
          live_risk_max_open_positions: number
          live_risk_max_symbol_exposure_pct: number
          live_risk_max_total_exposure_pct: number
          live_risk_max_unrealized_drawdown_pct: number
          max_concurrent_positions: number
          max_daily_loss_pct: number
          paper_fee_bps: number
          paper_fill_latency_ms: number
          paper_mode_enabled: boolean
          paper_slippage_bps: number
          paper_starting_balance_usdt: number
          singleton: boolean
          snapshot_signal_context_url: string | null
          testnet_enabled: boolean
          testnet_validated_at: string | null
          updated_at: string
          use_execution_bridge: boolean
          webhook_secret_hint: string | null
          webhook_secret_rotated_at: string | null
          webhook_secret_version: number
        }
        Insert: {
          auto_pause_on_critical_invariant?: boolean
          auto_snapshot_signal_context_enabled?: boolean
          chaos_config?: Json
          created_at?: string
          dedupe_window_seconds?: number
          default_leverage?: number
          email_ingest_enabled?: boolean
          emergency_stop?: boolean
          emergency_stop_blocks_exits?: boolean
          entries_paused?: boolean
          id?: string
          live_confirmation_phrase?: string | null
          live_enabled?: boolean
          live_risk_acknowledged_at?: string | null
          live_risk_acknowledged_by?: string | null
          live_risk_halt_metrics?: Json | null
          live_risk_halt_reason?: string | null
          live_risk_halted?: boolean
          live_risk_halted_at?: string | null
          live_risk_max_consecutive_losses?: number
          live_risk_max_daily_loss_pct?: number
          live_risk_max_open_positions?: number
          live_risk_max_symbol_exposure_pct?: number
          live_risk_max_total_exposure_pct?: number
          live_risk_max_unrealized_drawdown_pct?: number
          max_concurrent_positions?: number
          max_daily_loss_pct?: number
          paper_fee_bps?: number
          paper_fill_latency_ms?: number
          paper_mode_enabled?: boolean
          paper_slippage_bps?: number
          paper_starting_balance_usdt?: number
          singleton?: boolean
          snapshot_signal_context_url?: string | null
          testnet_enabled?: boolean
          testnet_validated_at?: string | null
          updated_at?: string
          use_execution_bridge?: boolean
          webhook_secret_hint?: string | null
          webhook_secret_rotated_at?: string | null
          webhook_secret_version?: number
        }
        Update: {
          auto_pause_on_critical_invariant?: boolean
          auto_snapshot_signal_context_enabled?: boolean
          chaos_config?: Json
          created_at?: string
          dedupe_window_seconds?: number
          default_leverage?: number
          email_ingest_enabled?: boolean
          emergency_stop?: boolean
          emergency_stop_blocks_exits?: boolean
          entries_paused?: boolean
          id?: string
          live_confirmation_phrase?: string | null
          live_enabled?: boolean
          live_risk_acknowledged_at?: string | null
          live_risk_acknowledged_by?: string | null
          live_risk_halt_metrics?: Json | null
          live_risk_halt_reason?: string | null
          live_risk_halted?: boolean
          live_risk_halted_at?: string | null
          live_risk_max_consecutive_losses?: number
          live_risk_max_daily_loss_pct?: number
          live_risk_max_open_positions?: number
          live_risk_max_symbol_exposure_pct?: number
          live_risk_max_total_exposure_pct?: number
          live_risk_max_unrealized_drawdown_pct?: number
          max_concurrent_positions?: number
          max_daily_loss_pct?: number
          paper_fee_bps?: number
          paper_fill_latency_ms?: number
          paper_mode_enabled?: boolean
          paper_slippage_bps?: number
          paper_starting_balance_usdt?: number
          singleton?: boolean
          snapshot_signal_context_url?: string | null
          testnet_enabled?: boolean
          testnet_validated_at?: string | null
          updated_at?: string
          use_execution_bridge?: boolean
          webhook_secret_hint?: string | null
          webhook_secret_rotated_at?: string | null
          webhook_secret_version?: number
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          after: Json | null
          before: Json | null
          created_at: string
          id: string
          ip: string | null
          target: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          ip?: string | null
          target?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          ip?: string | null
          target?: string | null
        }
        Relationships: []
      }
      balance_snapshots: {
        Row: {
          account_mode: string | null
          available_balance: number | null
          captured_at: string
          error: string | null
          id: string
          raw: Json | null
          realized_pnl: number | null
          source: string
          total_equity: number | null
          unrealized_pnl: number | null
          used_margin: number | null
        }
        Insert: {
          account_mode?: string | null
          available_balance?: number | null
          captured_at?: string
          error?: string | null
          id?: string
          raw?: Json | null
          realized_pnl?: number | null
          source: string
          total_equity?: number | null
          unrealized_pnl?: number | null
          used_margin?: number | null
        }
        Update: {
          account_mode?: string | null
          available_balance?: number | null
          captured_at?: string
          error?: string | null
          id?: string
          raw?: Json | null
          realized_pnl?: number | null
          source?: string
          total_equity?: number | null
          unrealized_pnl?: number | null
          used_margin?: number | null
        }
        Relationships: []
      }
      bridge_health_checks: {
        Row: {
          bridge_version: string | null
          bybit_reachable: boolean | null
          checked_at: string
          error: string | null
          http_status: number | null
          id: string
          latency_ms: number | null
          ok: boolean
          public_ip: string | null
          raw: Json | null
          region: string | null
        }
        Insert: {
          bridge_version?: string | null
          bybit_reachable?: boolean | null
          checked_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          ok: boolean
          public_ip?: string | null
          raw?: Json | null
          region?: string | null
        }
        Update: {
          bridge_version?: string | null
          bybit_reachable?: boolean | null
          checked_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          ok?: boolean
          public_ip?: string | null
          raw?: Json | null
          region?: string | null
        }
        Relationships: []
      }
      bridge_smoke_tests: {
        Row: {
          account_available: number | null
          account_equity: number | null
          bybit_ms: number | null
          checked_at: string
          error: string | null
          http_status: number | null
          id: string
          ok: boolean
          public_ip: string | null
          raw: Json | null
          ret_code: number | null
          ret_msg: string | null
          total_ms: number | null
        }
        Insert: {
          account_available?: number | null
          account_equity?: number | null
          bybit_ms?: number | null
          checked_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          ok: boolean
          public_ip?: string | null
          raw?: Json | null
          ret_code?: number | null
          ret_msg?: string | null
          total_ms?: number | null
        }
        Update: {
          account_available?: number | null
          account_equity?: number | null
          bybit_ms?: number | null
          checked_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          ok?: boolean
          public_ip?: string | null
          raw?: Json | null
          ret_code?: number | null
          ret_msg?: string | null
          total_ms?: number | null
        }
        Relationships: []
      }
      bybit_diagnostics: {
        Row: {
          account_type: string | null
          checks: Json
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          last_response: Json | null
          mode: string
          ok: boolean
          permissions: Json | null
          ran_by: string | null
        }
        Insert: {
          account_type?: string | null
          checks?: Json
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          last_response?: Json | null
          mode: string
          ok: boolean
          permissions?: Json | null
          ran_by?: string | null
        }
        Update: {
          account_type?: string | null
          checks?: Json
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          last_response?: Json | null
          mode?: string
          ok?: boolean
          permissions?: Json | null
          ran_by?: string | null
        }
        Relationships: []
      }
      bybit_request_traces: {
        Row: {
          amz_cf_id: string | null
          amz_cf_pop: string | null
          api_key_prefix: string | null
          attempt: number | null
          bapi_request_id: string | null
          base_url: string
          body_keys: Json | null
          body_sha256_prefix: string | null
          body_size: number | null
          body_snippet: string | null
          cf_ray: string | null
          content_type: string | null
          created_at: string
          duration_ms: number | null
          endpoint: string
          error_kind: string | null
          http_status: number | null
          id: string
          idempotency_key: string | null
          label: string
          method: string
          mode: string | null
          ok: boolean
          query: Json | null
          query_string: string | null
          recv_window_ms: number | null
          ret_code: number | null
          ret_msg: string | null
          server: string | null
          sign_len: number | null
          sign_payload_prefix: string | null
          signal_id: string | null
          timestamp_ms: number | null
          via: string | null
        }
        Insert: {
          amz_cf_id?: string | null
          amz_cf_pop?: string | null
          api_key_prefix?: string | null
          attempt?: number | null
          bapi_request_id?: string | null
          base_url: string
          body_keys?: Json | null
          body_sha256_prefix?: string | null
          body_size?: number | null
          body_snippet?: string | null
          cf_ray?: string | null
          content_type?: string | null
          created_at?: string
          duration_ms?: number | null
          endpoint: string
          error_kind?: string | null
          http_status?: number | null
          id?: string
          idempotency_key?: string | null
          label: string
          method: string
          mode?: string | null
          ok?: boolean
          query?: Json | null
          query_string?: string | null
          recv_window_ms?: number | null
          ret_code?: number | null
          ret_msg?: string | null
          server?: string | null
          sign_len?: number | null
          sign_payload_prefix?: string | null
          signal_id?: string | null
          timestamp_ms?: number | null
          via?: string | null
        }
        Update: {
          amz_cf_id?: string | null
          amz_cf_pop?: string | null
          api_key_prefix?: string | null
          attempt?: number | null
          bapi_request_id?: string | null
          base_url?: string
          body_keys?: Json | null
          body_sha256_prefix?: string | null
          body_size?: number | null
          body_snippet?: string | null
          cf_ray?: string | null
          content_type?: string | null
          created_at?: string
          duration_ms?: number | null
          endpoint?: string
          error_kind?: string | null
          http_status?: number | null
          id?: string
          idempotency_key?: string | null
          label?: string
          method?: string
          mode?: string | null
          ok?: boolean
          query?: Json | null
          query_string?: string | null
          recv_window_ms?: number | null
          ret_code?: number | null
          ret_msg?: string | null
          server?: string | null
          sign_len?: number | null
          sign_payload_prefix?: string | null
          signal_id?: string | null
          timestamp_ms?: number | null
          via?: string | null
        }
        Relationships: []
      }
      coin_admission_coingecko_map: {
        Row: {
          bybit_symbol: string
          coingecko_id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          bybit_symbol: string
          coingecko_id: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          bybit_symbol?: string
          coingecko_id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      coin_admission_profiles: {
        Row: {
          created_at: string
          description: string | null
          htq_default_lookback_days: number
          htq_min_neutral: number
          htq_min_trend_friendly: number
          id: string
          is_active: boolean
          name: string
          thresholds: Json
          updated_at: string
          weights: Json
        }
        Insert: {
          created_at?: string
          description?: string | null
          htq_default_lookback_days?: number
          htq_min_neutral?: number
          htq_min_trend_friendly?: number
          id?: string
          is_active?: boolean
          name: string
          thresholds: Json
          updated_at?: string
          weights: Json
        }
        Update: {
          created_at?: string
          description?: string | null
          htq_default_lookback_days?: number
          htq_min_neutral?: number
          htq_min_trend_friendly?: number
          id?: string
          is_active?: boolean
          name?: string
          thresholds?: Json
          updated_at?: string
          weights?: Json
        }
        Relationships: []
      }
      coin_admission_results: {
        Row: {
          admission_mode: string | null
          admission_reason: string | null
          coingecko_id: string | null
          components: Json | null
          created_at: string
          current_momentum_score: number | null
          extreme_wick_count: number | null
          fetch_error: string | null
          funding_rate: number | null
          hard_kill_rules: string[] | null
          historical_trend_quality: number | null
          htq_components: Json | null
          htq_lookback_days: number | null
          htq_mode: string | null
          htq_reason: string | null
          id: string
          kill_rules_triggered: string[] | null
          listing_age_days: number | null
          max_1h_drop_pct: number | null
          open_interest_value: number | null
          rank: number | null
          run_id: string
          score: number | null
          slippage_bps_est: number | null
          soft_failures: string[] | null
          spread_bps: number | null
          status: string
          strategy_fit_label: string | null
          strategy_fit_score: number | null
          symbol: string
          trend_classification: string | null
          trend_components: Json | null
          trend_score: number | null
          turnover_24h: number | null
          turnover_30d_median: number | null
          turnover_7d_median: number | null
          wick_risk_score: number | null
        }
        Insert: {
          admission_mode?: string | null
          admission_reason?: string | null
          coingecko_id?: string | null
          components?: Json | null
          created_at?: string
          current_momentum_score?: number | null
          extreme_wick_count?: number | null
          fetch_error?: string | null
          funding_rate?: number | null
          hard_kill_rules?: string[] | null
          historical_trend_quality?: number | null
          htq_components?: Json | null
          htq_lookback_days?: number | null
          htq_mode?: string | null
          htq_reason?: string | null
          id?: string
          kill_rules_triggered?: string[] | null
          listing_age_days?: number | null
          max_1h_drop_pct?: number | null
          open_interest_value?: number | null
          rank?: number | null
          run_id: string
          score?: number | null
          slippage_bps_est?: number | null
          soft_failures?: string[] | null
          spread_bps?: number | null
          status: string
          strategy_fit_label?: string | null
          strategy_fit_score?: number | null
          symbol: string
          trend_classification?: string | null
          trend_components?: Json | null
          trend_score?: number | null
          turnover_24h?: number | null
          turnover_30d_median?: number | null
          turnover_7d_median?: number | null
          wick_risk_score?: number | null
        }
        Update: {
          admission_mode?: string | null
          admission_reason?: string | null
          coingecko_id?: string | null
          components?: Json | null
          created_at?: string
          current_momentum_score?: number | null
          extreme_wick_count?: number | null
          fetch_error?: string | null
          funding_rate?: number | null
          hard_kill_rules?: string[] | null
          historical_trend_quality?: number | null
          htq_components?: Json | null
          htq_lookback_days?: number | null
          htq_mode?: string | null
          htq_reason?: string | null
          id?: string
          kill_rules_triggered?: string[] | null
          listing_age_days?: number | null
          max_1h_drop_pct?: number | null
          open_interest_value?: number | null
          rank?: number | null
          run_id?: string
          score?: number | null
          slippage_bps_est?: number | null
          soft_failures?: string[] | null
          spread_bps?: number | null
          status?: string
          strategy_fit_label?: string | null
          strategy_fit_score?: number | null
          symbol?: string
          trend_classification?: string | null
          trend_components?: Json | null
          trend_score?: number | null
          turnover_24h?: number | null
          turnover_30d_median?: number | null
          turnover_7d_median?: number | null
          wick_risk_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "coin_admission_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "coin_admission_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      coin_admission_runs: {
        Row: {
          admission_mode: string
          approved_n: number | null
          error: string | null
          finished_at: string | null
          htq_lookback_days: number | null
          htq_mode: string | null
          id: string
          include_trend_quality: boolean
          notes: string | null
          profile_id: string | null
          profile_name: string
          progress_done: number | null
          progress_total: number | null
          rejected_n: number | null
          started_at: string
          status: string
          symbols_total: number | null
          triggered_by: string | null
          watchlist_n: number | null
        }
        Insert: {
          admission_mode?: string
          approved_n?: number | null
          error?: string | null
          finished_at?: string | null
          htq_lookback_days?: number | null
          htq_mode?: string | null
          id?: string
          include_trend_quality?: boolean
          notes?: string | null
          profile_id?: string | null
          profile_name: string
          progress_done?: number | null
          progress_total?: number | null
          rejected_n?: number | null
          started_at?: string
          status?: string
          symbols_total?: number | null
          triggered_by?: string | null
          watchlist_n?: number | null
        }
        Update: {
          admission_mode?: string
          approved_n?: number | null
          error?: string | null
          finished_at?: string | null
          htq_lookback_days?: number | null
          htq_mode?: string | null
          id?: string
          include_trend_quality?: boolean
          notes?: string | null
          profile_id?: string | null
          profile_name?: string
          progress_done?: number | null
          progress_total?: number | null
          rejected_n?: number | null
          started_at?: string
          status?: string
          symbols_total?: number | null
          triggered_by?: string | null
          watchlist_n?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "coin_admission_runs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "coin_admission_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      error_log: {
        Row: {
          context: Json | null
          created_at: string
          id: string
          message: string
          request_id: string | null
          source: string | null
          stack: string | null
        }
        Insert: {
          context?: Json | null
          created_at?: string
          id?: string
          message: string
          request_id?: string | null
          source?: string | null
          stack?: string | null
        }
        Update: {
          context?: Json | null
          created_at?: string
          id?: string
          message?: string
          request_id?: string | null
          source?: string | null
          stack?: string | null
        }
        Relationships: []
      }
      execution_lock_events: {
        Row: {
          created_at: string
          event: string
          id: string
          kind: Database["public"]["Enums"]["lock_kind"]
          note: string | null
          owner_id: string
          previous_kind: Database["public"]["Enums"]["lock_kind"] | null
          previous_owner_id: string | null
          symbol: string
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          kind: Database["public"]["Enums"]["lock_kind"]
          note?: string | null
          owner_id: string
          previous_kind?: Database["public"]["Enums"]["lock_kind"] | null
          previous_owner_id?: string | null
          symbol: string
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          kind?: Database["public"]["Enums"]["lock_kind"]
          note?: string | null
          owner_id?: string
          previous_kind?: Database["public"]["Enums"]["lock_kind"] | null
          previous_owner_id?: string | null
          symbol?: string
        }
        Relationships: []
      }
      execution_locks: {
        Row: {
          acquired_at: string
          heartbeat_at: string
          job_id: string | null
          kind: Database["public"]["Enums"]["lock_kind"]
          metadata: Json
          owner_id: string
          signal_id: string | null
          symbol: string
          ttl_seconds: number
        }
        Insert: {
          acquired_at?: string
          heartbeat_at?: string
          job_id?: string | null
          kind: Database["public"]["Enums"]["lock_kind"]
          metadata?: Json
          owner_id: string
          signal_id?: string | null
          symbol: string
          ttl_seconds?: number
        }
        Update: {
          acquired_at?: string
          heartbeat_at?: string
          job_id?: string | null
          kind?: Database["public"]["Enums"]["lock_kind"]
          metadata?: Json
          owner_id?: string
          signal_id?: string | null
          symbol?: string
          ttl_seconds?: number
        }
        Relationships: []
      }
      health_snapshots: {
        Row: {
          bar_time: string | null
          created_at: string
          id: string
          net_profit: number | null
          payload: Json | null
          profit_factor: number | null
          source_signal_id: string | null
          strategy: string
          symbol: string
          tag: string
          winrate: number | null
        }
        Insert: {
          bar_time?: string | null
          created_at?: string
          id?: string
          net_profit?: number | null
          payload?: Json | null
          profit_factor?: number | null
          source_signal_id?: string | null
          strategy: string
          symbol: string
          tag?: string
          winrate?: number | null
        }
        Update: {
          bar_time?: string | null
          created_at?: string
          id?: string
          net_profit?: number | null
          payload?: Json | null
          profit_factor?: number | null
          source_signal_id?: string | null
          strategy?: string
          symbol?: string
          tag?: string
          winrate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "health_snapshots_source_signal_id_fkey"
            columns: ["source_signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      internal_hook_config: {
        Row: {
          name: string
          updated_at: string
          value: string
        }
        Insert: {
          name: string
          updated_at?: string
          value: string
        }
        Update: {
          name?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      invariant_runs: {
        Row: {
          auto_paused: boolean
          checks_failed: number
          checks_total: number
          critical_count: number
          detail: Json
          finished_at: string | null
          health_score: number
          id: string
          started_at: string
          warning_count: number
        }
        Insert: {
          auto_paused?: boolean
          checks_failed?: number
          checks_total?: number
          critical_count?: number
          detail?: Json
          finished_at?: string | null
          health_score?: number
          id?: string
          started_at?: string
          warning_count?: number
        }
        Update: {
          auto_paused?: boolean
          checks_failed?: number
          checks_total?: number
          critical_count?: number
          detail?: Json
          finished_at?: string | null
          health_score?: number
          id?: string
          started_at?: string
          warning_count?: number
        }
        Relationships: []
      }
      invariant_violations: {
        Row: {
          ack_note: string | null
          acknowledged_at: string | null
          acknowledged_by: string | null
          detail: Json
          first_seen_at: string
          id: string
          last_seen_at: string
          message: string
          occurrences: number
          resolved_at: string | null
          rule_code: string
          rule_label: string
          run_id: string | null
          severity: Database["public"]["Enums"]["invariant_severity"]
          target_key: string
          target_kind: string
        }
        Insert: {
          ack_note?: string | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          detail?: Json
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          message: string
          occurrences?: number
          resolved_at?: string | null
          rule_code: string
          rule_label: string
          run_id?: string | null
          severity?: Database["public"]["Enums"]["invariant_severity"]
          target_key: string
          target_kind: string
        }
        Update: {
          ack_note?: string | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          detail?: Json
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          message?: string
          occurrences?: number
          resolved_at?: string | null
          rule_code?: string
          rule_label?: string
          run_id?: string | null
          severity?: Database["public"]["Enums"]["invariant_severity"]
          target_key?: string
          target_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "invariant_violations_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "invariant_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_events: {
        Row: {
          category: string
          created_at: string
          dedupe_key: string | null
          error_message: string | null
          id: string
          payload: Json
          provider: string
          sent_at: string | null
          severity: Database["public"]["Enums"]["notification_severity"]
          status: Database["public"]["Enums"]["notification_status"]
        }
        Insert: {
          category: string
          created_at?: string
          dedupe_key?: string | null
          error_message?: string | null
          id?: string
          payload?: Json
          provider?: string
          sent_at?: string | null
          severity: Database["public"]["Enums"]["notification_severity"]
          status: Database["public"]["Enums"]["notification_status"]
        }
        Update: {
          category?: string
          created_at?: string
          dedupe_key?: string | null
          error_message?: string | null
          id?: string
          payload?: Json
          provider?: string
          sent_at?: string | null
          severity?: Database["public"]["Enums"]["notification_severity"]
          status?: Database["public"]["Enums"]["notification_status"]
        }
        Relationships: []
      }
      notification_settings: {
        Row: {
          created_at: string
          dedupe_window_seconds: number
          enabled_categories: Json
          id: string
          min_severity: Database["public"]["Enums"]["notification_severity"]
          rate_limit_seconds: number
          singleton: boolean
          telegram_enabled: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          dedupe_window_seconds?: number
          enabled_categories?: Json
          id?: string
          min_severity?: Database["public"]["Enums"]["notification_severity"]
          rate_limit_seconds?: number
          singleton?: boolean
          telegram_enabled?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          dedupe_window_seconds?: number
          enabled_categories?: Json
          id?: string
          min_severity?: Database["public"]["Enums"]["notification_severity"]
          rate_limit_seconds?: number
          singleton?: boolean
          telegram_enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          bybit_order_id: string | null
          created_at: string
          error_message: string | null
          execution_mode: Database["public"]["Enums"]["execution_mode"]
          finalized_at: string | null
          id: string
          order_type: string | null
          position_id: string | null
          price: number | null
          purpose: Database["public"]["Enums"]["order_purpose"]
          qty: number | null
          request_payload: Json | null
          response_payload: Json | null
          side: string
          signal_id: string | null
          status: Database["public"]["Enums"]["order_status"]
          submitted_at: string
          symbol: string
        }
        Insert: {
          bybit_order_id?: string | null
          created_at?: string
          error_message?: string | null
          execution_mode?: Database["public"]["Enums"]["execution_mode"]
          finalized_at?: string | null
          id?: string
          order_type?: string | null
          position_id?: string | null
          price?: number | null
          purpose: Database["public"]["Enums"]["order_purpose"]
          qty?: number | null
          request_payload?: Json | null
          response_payload?: Json | null
          side: string
          signal_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          submitted_at?: string
          symbol: string
        }
        Update: {
          bybit_order_id?: string | null
          created_at?: string
          error_message?: string | null
          execution_mode?: Database["public"]["Enums"]["execution_mode"]
          finalized_at?: string | null
          id?: string
          order_type?: string | null
          position_id?: string | null
          price?: number | null
          purpose?: Database["public"]["Enums"]["order_purpose"]
          qty?: number | null
          request_payload?: Json | null
          response_payload?: Json | null
          side?: string
          signal_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          submitted_at?: string
          symbol?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_market_prices: {
        Row: {
          price: number
          received_at: string
          source: string
          symbol: string
        }
        Insert: {
          price: number
          received_at?: string
          source?: string
          symbol: string
        }
        Update: {
          price?: number
          received_at?: string
          source?: string
          symbol?: string
        }
        Relationships: []
      }
      paper_wallet: {
        Row: {
          balance_usdt: number
          equity_usdt: number
          id: string
          realized_pnl: number
          singleton: boolean
          unrealized_pnl: number
          updated_at: string
        }
        Insert: {
          balance_usdt?: number
          equity_usdt?: number
          id?: string
          realized_pnl?: number
          singleton?: boolean
          unrealized_pnl?: number
          updated_at?: string
        }
        Update: {
          balance_usdt?: number
          equity_usdt?: number
          id?: string
          realized_pnl?: number
          singleton?: boolean
          unrealized_pnl?: number
          updated_at?: string
        }
        Relationships: []
      }
      position_events: {
        Row: {
          created_at: string
          detail: Json | null
          event_type: string
          id: string
          position_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json | null
          event_type: string
          id?: string
          position_id: string
        }
        Update: {
          created_at?: string
          detail?: Json | null
          event_type?: string
          id?: string
          position_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "position_events_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          closed_at: string | null
          created_at: string
          entry_price: number | null
          entry_signal_id: string | null
          execution_mode: Database["public"]["Enums"]["execution_mode"]
          exit_recovery_attempts: number
          exit_recovery_last_at: string | null
          exit_recovery_last_error: string | null
          exit_recovery_requested_at: string | null
          exit_recovery_state: string | null
          id: string
          last_exit_signal_id: string | null
          last_seen_price: number | null
          leverage: number | null
          opened_at: string
          protection_state: Database["public"]["Enums"]["protection_state"]
          qty_initial: number | null
          qty_open: number | null
          realized_pnl: number
          side: Database["public"]["Enums"]["position_side"]
          sl_order_id: string | null
          sl_price: number | null
          symbol: string
          tp1_done: boolean
          tp1_qty: number | null
          tp2_done: boolean
          tsl_activated_at: string | null
          tsl_active: boolean
          tsl_high_water_price: number | null
          tsl_order_id: string | null
          tsl_trigger_price: number | null
          unprotected_since: string | null
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          entry_price?: number | null
          entry_signal_id?: string | null
          execution_mode?: Database["public"]["Enums"]["execution_mode"]
          exit_recovery_attempts?: number
          exit_recovery_last_at?: string | null
          exit_recovery_last_error?: string | null
          exit_recovery_requested_at?: string | null
          exit_recovery_state?: string | null
          id?: string
          last_exit_signal_id?: string | null
          last_seen_price?: number | null
          leverage?: number | null
          opened_at?: string
          protection_state?: Database["public"]["Enums"]["protection_state"]
          qty_initial?: number | null
          qty_open?: number | null
          realized_pnl?: number
          side: Database["public"]["Enums"]["position_side"]
          sl_order_id?: string | null
          sl_price?: number | null
          symbol: string
          tp1_done?: boolean
          tp1_qty?: number | null
          tp2_done?: boolean
          tsl_activated_at?: string | null
          tsl_active?: boolean
          tsl_high_water_price?: number | null
          tsl_order_id?: string | null
          tsl_trigger_price?: number | null
          unprotected_since?: string | null
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          entry_price?: number | null
          entry_signal_id?: string | null
          execution_mode?: Database["public"]["Enums"]["execution_mode"]
          exit_recovery_attempts?: number
          exit_recovery_last_at?: string | null
          exit_recovery_last_error?: string | null
          exit_recovery_requested_at?: string | null
          exit_recovery_state?: string | null
          id?: string
          last_exit_signal_id?: string | null
          last_seen_price?: number | null
          leverage?: number | null
          opened_at?: string
          protection_state?: Database["public"]["Enums"]["protection_state"]
          qty_initial?: number | null
          qty_open?: number | null
          realized_pnl?: number
          side?: Database["public"]["Enums"]["position_side"]
          sl_order_id?: string | null
          sl_price?: number | null
          symbol?: string
          tp1_done?: boolean
          tp1_qty?: number | null
          tp2_done?: boolean
          tsl_activated_at?: string | null
          tsl_active?: boolean
          tsl_high_water_price?: number | null
          tsl_order_id?: string | null
          tsl_trigger_price?: number | null
          unprotected_since?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_entry_signal_id_fkey"
            columns: ["entry_signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_last_exit_signal_id_fkey"
            columns: ["last_exit_signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_alerts: {
        Row: {
          auth_method: string | null
          auth_status: Database["public"]["Enums"]["auth_status"]
          body_text: string | null
          created_at: string
          headers: Json | null
          id: string
          received_at: string
          remote_ip: string | null
          signal_id: string | null
          transport: Database["public"]["Enums"]["transport_kind"]
        }
        Insert: {
          auth_method?: string | null
          auth_status: Database["public"]["Enums"]["auth_status"]
          body_text?: string | null
          created_at?: string
          headers?: Json | null
          id?: string
          received_at?: string
          remote_ip?: string | null
          signal_id?: string | null
          transport: Database["public"]["Enums"]["transport_kind"]
        }
        Update: {
          auth_method?: string | null
          auth_status?: Database["public"]["Enums"]["auth_status"]
          body_text?: string | null
          created_at?: string
          headers?: Json | null
          id?: string
          received_at?: string
          remote_ip?: string | null
          signal_id?: string | null
          transport?: Database["public"]["Enums"]["transport_kind"]
        }
        Relationships: [
          {
            foreignKeyName: "raw_alerts_signal_fk"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      regime_snapshots: {
        Row: {
          bar_time: string | null
          captured_at: string
          id: string
          payload: Json
          regime_class: string | null
          symbol: string
          timeframe: string
        }
        Insert: {
          bar_time?: string | null
          captured_at?: string
          id?: string
          payload?: Json
          regime_class?: string | null
          symbol: string
          timeframe: string
        }
        Update: {
          bar_time?: string | null
          captured_at?: string
          id?: string
          payload?: Json
          regime_class?: string | null
          symbol?: string
          timeframe?: string
        }
        Relationships: []
      }
      risk_decisions: {
        Row: {
          created_at: string
          gate: Database["public"]["Enums"]["risk_gate"]
          id: string
          metrics: Json | null
          outcome: Database["public"]["Enums"]["risk_outcome"]
          reason: string | null
          signal_id: string | null
        }
        Insert: {
          created_at?: string
          gate: Database["public"]["Enums"]["risk_gate"]
          id?: string
          metrics?: Json | null
          outcome: Database["public"]["Enums"]["risk_outcome"]
          reason?: string | null
          signal_id?: string | null
        }
        Update: {
          created_at?: string
          gate?: Database["public"]["Enums"]["risk_gate"]
          id?: string
          metrics?: Json | null
          outcome?: Database["public"]["Enums"]["risk_outcome"]
          reason?: string | null
          signal_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "risk_decisions_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      scenario_runs: {
        Row: {
          created_by: string | null
          finished_at: string | null
          id: string
          preset: string
          started_at: string
          status: string
          steps: Json
          symbol: string
        }
        Insert: {
          created_by?: string | null
          finished_at?: string | null
          id?: string
          preset: string
          started_at?: string
          status?: string
          steps?: Json
          symbol: string
        }
        Update: {
          created_by?: string | null
          finished_at?: string | null
          id?: string
          preset?: string
          started_at?: string
          status?: string
          steps?: Json
          symbol?: string
        }
        Relationships: []
      }
      signal_context_snapshots: {
        Row: {
          bar_time: string | null
          created_at: string
          environment: string | null
          id: string
          payload: Json
          signal_id: string | null
          strategy: string | null
          symbol: string
          tag: string | null
          tf_role: string
          timeframe: string | null
        }
        Insert: {
          bar_time?: string | null
          created_at?: string
          environment?: string | null
          id?: string
          payload?: Json
          signal_id?: string | null
          strategy?: string | null
          symbol: string
          tag?: string | null
          tf_role: string
          timeframe?: string | null
        }
        Update: {
          bar_time?: string | null
          created_at?: string
          environment?: string | null
          id?: string
          payload?: Json
          signal_id?: string | null
          strategy?: string | null
          symbol?: string
          tag?: string | null
          tf_role?: string
          timeframe?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signal_context_snapshots_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      signals: {
        Row: {
          action: Database["public"]["Enums"]["signal_action"] | null
          bar_time: string | null
          bypass_dedupe: boolean
          created_at: string
          decision_reason: string | null
          decision_trail: Json
          dedupe_key: string
          entry_reason: Database["public"]["Enums"]["entry_reason"] | null
          error_stack: string | null
          exit_reason: Database["public"]["Enums"]["exit_reason"] | null
          id: string
          payload: Json
          portion: Database["public"]["Enums"]["signal_portion"]
          processed_at: string | null
          received_at: string
          replay_at: string | null
          replay_by: string | null
          replay_of: string | null
          request_id: string | null
          retry_count: number
          status: Database["public"]["Enums"]["signal_status"]
          strategy: string | null
          strategy_code: string | null
          symbol: string | null
          tag: string | null
          trade_timeframe: string | null
          transport: Database["public"]["Enums"]["transport_kind"]
          type: Database["public"]["Enums"]["signal_type"]
        }
        Insert: {
          action?: Database["public"]["Enums"]["signal_action"] | null
          bar_time?: string | null
          bypass_dedupe?: boolean
          created_at?: string
          decision_reason?: string | null
          decision_trail?: Json
          dedupe_key: string
          entry_reason?: Database["public"]["Enums"]["entry_reason"] | null
          error_stack?: string | null
          exit_reason?: Database["public"]["Enums"]["exit_reason"] | null
          id?: string
          payload: Json
          portion?: Database["public"]["Enums"]["signal_portion"]
          processed_at?: string | null
          received_at?: string
          replay_at?: string | null
          replay_by?: string | null
          replay_of?: string | null
          request_id?: string | null
          retry_count?: number
          status?: Database["public"]["Enums"]["signal_status"]
          strategy?: string | null
          strategy_code?: string | null
          symbol?: string | null
          tag?: string | null
          trade_timeframe?: string | null
          transport: Database["public"]["Enums"]["transport_kind"]
          type: Database["public"]["Enums"]["signal_type"]
        }
        Update: {
          action?: Database["public"]["Enums"]["signal_action"] | null
          bar_time?: string | null
          bypass_dedupe?: boolean
          created_at?: string
          decision_reason?: string | null
          decision_trail?: Json
          dedupe_key?: string
          entry_reason?: Database["public"]["Enums"]["entry_reason"] | null
          error_stack?: string | null
          exit_reason?: Database["public"]["Enums"]["exit_reason"] | null
          id?: string
          payload?: Json
          portion?: Database["public"]["Enums"]["signal_portion"]
          processed_at?: string | null
          received_at?: string
          replay_at?: string | null
          replay_by?: string | null
          replay_of?: string | null
          request_id?: string | null
          retry_count?: number
          status?: Database["public"]["Enums"]["signal_status"]
          strategy?: string | null
          strategy_code?: string | null
          symbol?: string | null
          tag?: string | null
          trade_timeframe?: string | null
          transport?: Database["public"]["Enums"]["transport_kind"]
          type?: Database["public"]["Enums"]["signal_type"]
        }
        Relationships: []
      }
      sizing_rules: {
        Row: {
          action: Json
          condition: Json
          created_at: string
          enabled: boolean
          id: string
          label: string
          priority: number
          updated_at: string
        }
        Insert: {
          action?: Json
          condition?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          label: string
          priority: number
          updated_at?: string
        }
        Update: {
          action?: Json
          condition?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          label?: string
          priority?: number
          updated_at?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          enabled: boolean
          health_min_net_profit: number | null
          health_min_profit_factor: number | null
          health_min_winrate: number | null
          id: string
          last_health_at: string | null
          name: string
          tag: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          health_min_net_profit?: number | null
          health_min_profit_factor?: number | null
          health_min_winrate?: number | null
          id?: string
          last_health_at?: string | null
          name: string
          tag?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          health_min_net_profit?: number | null
          health_min_profit_factor?: number | null
          health_min_winrate?: number | null
          id?: string
          last_health_at?: string | null
          name?: string
          tag?: string
          updated_at?: string
        }
        Relationships: []
      }
      strategy_codes: {
        Row: {
          code: string
          description: string
          entry_reason: Database["public"]["Enums"]["entry_reason"] | null
          exit_reason: Database["public"]["Enums"]["exit_reason"] | null
          kind: string
          side: Database["public"]["Enums"]["position_side"]
        }
        Insert: {
          code: string
          description: string
          entry_reason?: Database["public"]["Enums"]["entry_reason"] | null
          exit_reason?: Database["public"]["Enums"]["exit_reason"] | null
          kind: string
          side: Database["public"]["Enums"]["position_side"]
        }
        Update: {
          code?: string
          description?: string
          entry_reason?: Database["public"]["Enums"]["entry_reason"] | null
          exit_reason?: Database["public"]["Enums"]["exit_reason"] | null
          kind?: string
          side?: Database["public"]["Enums"]["position_side"]
        }
        Relationships: []
      }
      symbol_strategy_overrides: {
        Row: {
          account_balance_percent: number | null
          created_at: string
          force_state: string | null
          id: string
          leverage: number | null
          max_margin_usage_usdt: number | null
          max_position_notional_usdt: number | null
          notes: string | null
          position_size_multiplier: number | null
          strategy: string
          symbol: string
          tag: string
          updated_at: string
        }
        Insert: {
          account_balance_percent?: number | null
          created_at?: string
          force_state?: string | null
          id?: string
          leverage?: number | null
          max_margin_usage_usdt?: number | null
          max_position_notional_usdt?: number | null
          notes?: string | null
          position_size_multiplier?: number | null
          strategy: string
          symbol: string
          tag?: string
          updated_at?: string
        }
        Update: {
          account_balance_percent?: number | null
          created_at?: string
          force_state?: string | null
          id?: string
          leverage?: number | null
          max_margin_usage_usdt?: number | null
          max_position_notional_usdt?: number | null
          notes?: string | null
          position_size_multiplier?: number | null
          strategy?: string
          symbol?: string
          tag?: string
          updated_at?: string
        }
        Relationships: []
      }
      symbols: {
        Row: {
          account_balance_percent: number
          category: string
          created_at: string
          display_symbol: string | null
          enabled: boolean
          execution_mode_override:
            | Database["public"]["Enums"]["execution_mode"]
            | null
          id: string
          leverage: number
          margin_mode: Database["public"]["Enums"]["margin_mode"]
          max_margin_usage_usdt: number | null
          max_position_notional_usdt: number | null
          notes: string | null
          position_size_multiplier: number
          preferred_transport: Database["public"]["Enums"]["transport_pref"]
          sl_pct: number
          symbol: string
          tp1_exit_percent: number
          tp2_enabled: boolean
          tsl_activation_profit_pct: number
          tsl_callback_pct: number
          tsl_enabled: boolean
          updated_at: string
        }
        Insert: {
          account_balance_percent?: number
          category?: string
          created_at?: string
          display_symbol?: string | null
          enabled?: boolean
          execution_mode_override?:
            | Database["public"]["Enums"]["execution_mode"]
            | null
          id?: string
          leverage?: number
          margin_mode?: Database["public"]["Enums"]["margin_mode"]
          max_margin_usage_usdt?: number | null
          max_position_notional_usdt?: number | null
          notes?: string | null
          position_size_multiplier?: number
          preferred_transport?: Database["public"]["Enums"]["transport_pref"]
          sl_pct?: number
          symbol: string
          tp1_exit_percent?: number
          tp2_enabled?: boolean
          tsl_activation_profit_pct?: number
          tsl_callback_pct?: number
          tsl_enabled?: boolean
          updated_at?: string
        }
        Update: {
          account_balance_percent?: number
          category?: string
          created_at?: string
          display_symbol?: string | null
          enabled?: boolean
          execution_mode_override?:
            | Database["public"]["Enums"]["execution_mode"]
            | null
          id?: string
          leverage?: number
          margin_mode?: Database["public"]["Enums"]["margin_mode"]
          max_margin_usage_usdt?: number | null
          max_position_notional_usdt?: number | null
          notes?: string | null
          position_size_multiplier?: number
          preferred_transport?: Database["public"]["Enums"]["transport_pref"]
          sl_pct?: number
          symbol?: string
          tp1_exit_percent?: number
          tp2_enabled?: boolean
          tsl_activation_profit_pct?: number
          tsl_callback_pct?: number
          tsl_enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      system_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          category: string
          context: Json | null
          created_at: string
          id: string
          message: string
          severity: Database["public"]["Enums"]["alert_severity"]
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          category: string
          context?: Json | null
          created_at?: string
          id?: string
          message: string
          severity: Database["public"]["Enums"]["alert_severity"]
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          category?: string
          context?: Json | null
          created_at?: string
          id?: string
          message?: string
          severity?: Database["public"]["Enums"]["alert_severity"]
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      current_execution_locks: {
        Row: {
          acquired_at: string | null
          age_seconds: number | null
          expires_at: string | null
          heartbeat_age_seconds: number | null
          heartbeat_at: string | null
          is_stale: boolean | null
          job_id: string | null
          kind: Database["public"]["Enums"]["lock_kind"] | null
          metadata: Json | null
          owner_id: string | null
          seconds_until_expiry: number | null
          signal_id: string | null
          symbol: string | null
          ttl_seconds: number | null
        }
        Insert: {
          acquired_at?: string | null
          age_seconds?: never
          expires_at?: never
          heartbeat_age_seconds?: never
          heartbeat_at?: string | null
          is_stale?: never
          job_id?: string | null
          kind?: Database["public"]["Enums"]["lock_kind"] | null
          metadata?: Json | null
          owner_id?: string | null
          seconds_until_expiry?: never
          signal_id?: string | null
          symbol?: string | null
          ttl_seconds?: number | null
        }
        Update: {
          acquired_at?: string | null
          age_seconds?: never
          expires_at?: never
          heartbeat_age_seconds?: never
          heartbeat_at?: string | null
          is_stale?: never
          job_id?: string | null
          kind?: Database["public"]["Enums"]["lock_kind"] | null
          metadata?: Json | null
          owner_id?: string | null
          seconds_until_expiry?: never
          signal_id?: string | null
          symbol?: string | null
          ttl_seconds?: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      acknowledge_invariant_violation: {
        Args: { _id: string; _note: string }
        Returns: boolean
      }
      acknowledge_live_risk_halt: { Args: { _note?: string }; Returns: boolean }
      acquire_execution_lock: {
        Args: {
          _allow_preempt: boolean
          _job_id: string
          _kind: Database["public"]["Enums"]["lock_kind"]
          _owner_id: string
          _signal_id: string
          _symbol: string
          _ttl_seconds: number
        }
        Returns: Json
      }
      equity_snapshots_bucketed: {
        Args: { _buckets?: number; _since: string; _source: string }
        Returns: {
          captured_at: string
          total_equity: number
        }[]
      }
      expire_stale_locks: { Args: never; Returns: number }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      heartbeat_execution_lock: {
        Args: { _owner_id: string; _symbol: string }
        Returns: boolean
      }
      lock_can_preempt: {
        Args: {
          _current: Database["public"]["Enums"]["lock_kind"]
          _requested: Database["public"]["Enums"]["lock_kind"]
        }
        Returns: boolean
      }
      manually_close_position: {
        Args: { _exit_price: number; _note?: string; _position_id: string }
        Returns: Json
      }
      release_execution_lock: {
        Args: { _owner_id: string; _symbol: string }
        Returns: boolean
      }
      replay_signal: {
        Args: { _bypass_dedupe: boolean; _signal_id: string }
        Returns: string
      }
      steal_execution_lock: { Args: { _symbol: string }; Returns: Json }
      trigger_live_risk_halt: {
        Args: { _metrics: Json; _reason: string }
        Returns: boolean
      }
    }
    Enums: {
      alert_severity: "info" | "warning" | "critical"
      app_role: "operator"
      auth_status: "ok" | "bad_secret" | "malformed"
      entry_reason: "long_entry" | "short_entry"
      execution_mode: "live" | "paper" | "testnet"
      exit_reason:
        | "tp1"
        | "tp2_rest"
        | "sl_failsafe"
        | "opposite"
        | "trend_fail"
      invariant_severity: "info" | "warning" | "critical"
      lock_kind:
        | "entry"
        | "exit"
        | "replay"
        | "reconcile"
        | "protect"
        | "manual"
      margin_mode: "isolated" | "cross"
      notification_severity: "info" | "warning" | "critical"
      notification_status: "sent" | "skipped" | "failed"
      order_purpose:
        | "entry"
        | "sl"
        | "tsl"
        | "tp1"
        | "tp2_rest"
        | "exit_full"
        | "manual_close"
      order_status:
        | "submitted"
        | "filled"
        | "partial"
        | "cancelled"
        | "rejected"
        | "error"
      position_side: "long" | "short"
      protection_state: "unprotected" | "sl_only" | "sl_and_tsl" | "closed"
      risk_gate:
        | "health"
        | "risk"
        | "kill_switch"
        | "dedupe"
        | "unprotected_pause"
        | "transport_mismatch"
        | "exposure_limit"
      risk_outcome: "pass" | "block"
      signal_action:
        | "ENTER-LONG"
        | "ENTER-SHORT"
        | "EXIT-LONG"
        | "EXIT-SHORT"
        | "HEALTH"
      signal_portion: "full" | "tp1" | "rest"
      signal_status:
        | "queued"
        | "processing"
        | "accepted"
        | "rejected"
        | "error"
        | "processed"
        | "dead_letter"
      signal_type: "trade" | "stats"
      transport_kind: "webhook" | "email"
      transport_pref: "webhook" | "email" | "either"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      alert_severity: ["info", "warning", "critical"],
      app_role: ["operator"],
      auth_status: ["ok", "bad_secret", "malformed"],
      entry_reason: ["long_entry", "short_entry"],
      execution_mode: ["live", "paper", "testnet"],
      exit_reason: ["tp1", "tp2_rest", "sl_failsafe", "opposite", "trend_fail"],
      invariant_severity: ["info", "warning", "critical"],
      lock_kind: ["entry", "exit", "replay", "reconcile", "protect", "manual"],
      margin_mode: ["isolated", "cross"],
      notification_severity: ["info", "warning", "critical"],
      notification_status: ["sent", "skipped", "failed"],
      order_purpose: [
        "entry",
        "sl",
        "tsl",
        "tp1",
        "tp2_rest",
        "exit_full",
        "manual_close",
      ],
      order_status: [
        "submitted",
        "filled",
        "partial",
        "cancelled",
        "rejected",
        "error",
      ],
      position_side: ["long", "short"],
      protection_state: ["unprotected", "sl_only", "sl_and_tsl", "closed"],
      risk_gate: [
        "health",
        "risk",
        "kill_switch",
        "dedupe",
        "unprotected_pause",
        "transport_mismatch",
        "exposure_limit",
      ],
      risk_outcome: ["pass", "block"],
      signal_action: [
        "ENTER-LONG",
        "ENTER-SHORT",
        "EXIT-LONG",
        "EXIT-SHORT",
        "HEALTH",
      ],
      signal_portion: ["full", "tp1", "rest"],
      signal_status: [
        "queued",
        "processing",
        "accepted",
        "rejected",
        "error",
        "processed",
        "dead_letter",
      ],
      signal_type: ["trade", "stats"],
      transport_kind: ["webhook", "email"],
      transport_pref: ["webhook", "email", "either"],
    },
  },
} as const
