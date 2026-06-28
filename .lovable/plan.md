## Mål
Legg til hover-tooltips på alle kolonneoverskrifter i `/admission`-tabellen, slik at du raskt kan se hva hver kolonne måler og hvilken kilde/formel som ligger bak.

## Hva som gjøres
- Bruk eksisterende shadcn `Tooltip` (`TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent`) i `src/routes/_app.admission.tsx`.
- Wrap hver `<th>` i tabellheader med en tooltip-trigger. Header-teksten får en stiplet underline + `cursor-help` for å signalisere at det finnes forklaring.
- Ingen endringer i scoring, data, filtere eller backend. Kun presentasjon.

## Tooltip-tekster (kort definisjon + kilde)

| Kolonne | Tooltip |
|---|---|
| **Symbol** | Bybit perp-symbol (LinearPerpetual USDT). |
| **Status** | Admission-resultat: Approved / Watchlist / Trend Candidate / Rejected. Bestemmes av modus (Strict eller Trend Adjusted), hard kill rules, soft requirements og evt. HTQ-kompensasjon. |
| **Class** | Trend Classification fra HTQ v2: Trend Friendly (≥75), Neutral (55–74), Choppy (<55). |
| **Fit** | Strategy Fit Score = 0.6 × Robustness + 0.4 × HTQ. Brukes til Trend Adjusted-status. |
| **Robust** | Robustness Score (0–100). Vektet sum av Rank, Turnover (24h/7d), OI, Spread, Age og Wick Risk. |
| **HTQ** | Historical Trend Quality (0–100). Måler historisk trendvennlighet over valgt lookback. Komponenter: 1h Persistence (30%), MTF Alignment (20%), 5m Tradeability (20%), Flip Frequency (15%), Smoothness (10%), Wick Penalty (5%). |
| **Mom** | Current Momentum Score (0–100). Live EMA-alignment på 5m/15m/1h + ADX/ATR/Chop/Pullback på siste candle. Kun informativ — påvirker ikke status. |
| **Rank** | CoinGecko market-cap rank for base-coin. Lavere = større. |
| **24h TO** | 24-timers turnover i USDT fra Bybit `/v5/market/tickers`. |
| **OI** | Open Interest Value (USDT) fra Bybit tickers. |
| **Spread** | Bid/ask-spread i basispunkter ((ask−bid)/mid × 10000). |
| **Age** | Dager siden Bybit listing (`launchTime`). |
| **Wick%** | Største 1h wick som % av high (max (high−low)/high på siste 30d hourly). Lav er bra. |
| **Hard Kills** | Brudd som ALDRI kan overstyres (f.eks. for ny, for lav likviditet, ekstreme wicks). Trigger automatisk Rejected. |
| **Soft** | Krav som KAN lempes ved høy HTQ i Trend Adjusted-modus (f.eks. lavere rank/turnover-grenser). |
| **Reason** | Kort menneskelig forklaring på statusen (hvilke regler som slo inn / hvorfor lempet). |

## Tekniske detaljer
- Filendring: kun `src/routes/_app.admission.tsx`.
- Importer Tooltip-komponentene fra `@/components/ui/tooltip` hvis ikke allerede importert.
- Pakk hele tabellen (eller tabell-headeren) i én `<TooltipProvider delayDuration={150}>`.
- `TooltipContent` får `max-w-xs text-xs` for lesbarhet, `side="top"`.
- Ingen endringer i kolonner, datafelt eller scoring-logikk.
