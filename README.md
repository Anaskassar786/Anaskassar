# Trading AI AK

Private personal multi-agent **position trading decision-support** terminal for spot gold (XAU/USD) and major/minor FX.

This system is **not a broker**. It has **no execution capability**. It must **never fabricate** prices, candles, indicators, API responses, backtests, win rates, confidence-as-probability, or news. Failed feeds return `DATA_UNAVAILABLE` / `INSUFFICIENT DATA`.

## Architecture

```
User screenshot + risk inputs
        → Phase 0  Vision OCR (symbol, TF, price)
        → Phase 1  Immutable freeze (Twelve Data, FRED, News)
        → HARD GUARD: zero data (feeds + vision) → DATA_UNAVAILABLE, council never runs
        → Phase 2  10 isolated specialists (2/batch + 3s delay)
        → Phase 3  Bull vs Bear adversarial debate
        → Phase 4  11th Chief Judge + position sizing
        → Terminal dashboard + session storage
```

## Quick start

```bash
cp .env.example .env.local   # fill server-side keys only
npm install
npm run dev                  # http://localhost:3000 → /dashboard
```

Never expose API keys to the browser. `.env.local` is gitignored.

## Environment variables (`.env.local`)

All keys are **server-side only** — nothing is `NEXT_PUBLIC_*` except `NEXT_PUBLIC_APP_URL`.

| Variable | Used by | If missing |
| --- | --- | --- |
| `OPENROUTER_API_KEY` (+ `_BASE_URL`, `_DEFAULT_MODEL`, `_FALLBACK_MODELS`) | Phase 0 vision (primary), 10 agents, debate — OpenRouter/Gemini 3.6+ | Retired Gemini 2.0 ids are skipped automatically; remaining catalog models then other providers are tried. If every LLM fails, agents return explicit `NO_TRADE` / `INSUFFICIENT` |
| `GEMINI_API_KEY` (+ `_BASE_URL`, `_DEFAULT_MODEL`, `_FALLBACK_MODELS`) | Vision fallback + LLM failover (native Gemini API, default `gemini-3.6-flash`) | Next catalog model is tried; 404 bodies that name a replacement model are honoured |
| `NVIDIA_API_KEY` (+ `_BASE_URL`, `_DEFAULT_MODEL`) | **Default for everything** — vision, 10 agents, debate, Chief Judge (MiniMax NIM) | Set `LLM_PROVIDER_ORDER=nvidia` (default). Add `,openrouter,gemini` only if you want failover |
| `MINIMAX_API_KEY` / `MINIMAX_DEFAULT_MODEL` | Reserved (MiniMax is currently routed via NVIDIA) | Unused |
| `TWELVE_DATA_API_KEY` (+ `_BASE_URL`) | Market candles (Phase 1 freeze) | `DATA_UNAVAILABLE` market feed |
| `FRED_API_KEY` (+ `_BASE_URL`) | Macro — FEDFUNDS (Phase 1 freeze) | `DATA_UNAVAILABLE` macro feed |
| `NEWS_API_KEY` (+ `_BASE_URL`) | Headlines (Phase 1 freeze) | `DATA_UNAVAILABLE` news feed |
| `NEXT_PUBLIC_APP_URL` | OpenRouter `HTTP-Referer` header, app base URL | Defaults to `http://localhost:3000` |
| `DATABASE_URL` | **Optional / reserved** — this checkout persists to the file store under `data/`. If you prefer Supabase/Postgres, run `lib/db/schema.sql` and use your own store | File store is used; terminal works with zero external services |

> ⚠ Gemini 2.0 Flash (`gemini-2.0-flash`, `google/gemini-2.0-flash-001`) is **retired**. If your `.env.local` still points at those ids the client skips them and uses Gemini 3.6 / 3.5 / 2.5 Flash instead. A failed council run (all agents `fallback`) is **not** frozen for replay, so you can re-run after keys/models recover.
>
> ⚠ OpenRouter **402** (`requested up to 65536 tokens, but can only afford N`) is a **credit reservation** bug if `max_tokens` is omitted. The client now always sends `max_tokens` (default 4096 via `LLM_MAX_TOKENS`). Gemini/NVIDIA **429** trips a short cooldown so the next agents do not keep burning the free-tier quota. Add OpenRouter credits if the balance is actually empty.
>
> ⚠ The `MINIMAX_API_KEY` shipped in the original spec appears to contain an embedded `Bearer` prefix (copy artifact). It is unused today; fix it in your key registry if you plan to route MiniMax directly.

**Hard guard:** if the screenshot yields no usable data (UNKNOWN symbol, no price, 0 parse confidence) **and** all three feeds fail, the pipeline returns `DATA_UNAVAILABLE` immediately — the 10 agents and the judge are never asked to analyze nothing.

## Storage

Sessions are frozen as JSON snapshots under `data/sessions/` (+ `data/index.json`, `data/screenshots/`, `data/health.json`). Re-uploading the same screenshot replays the **frozen** session — live APIs are not recalled. `lib/db/schema.sql` is the equivalent Supabase/Postgres DDL for anyone who wants relational storage.

## API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/analyze` | POST (multipart) | Full pipeline. `stream=1` for live SSE phase/agent events. `reuseFrozen=false` forces a fresh run |
| `/api/health` | GET | Live probes: Twelve Data, FRED, News (real calls) + OpenRouter, NVIDIA, Gemini (`GET /models`, verifies key validity + connectivity) + file store. History kept in `data/health.json` |
| `/api/sessions` | GET | Session index |
| `/api/sessions/:id` | GET | Frozen session (no live API recall) |
| `/api/sessions/:id/outcome` | POST | WIN / LOSS / BREAKEVEN / SKIPPED — feedback only, never alters rules |
| `/api/screenshots/:filename` | GET | Serves the stored uploaded chart |

## Core paths

| Path | Role |
| --- | --- |
| `types/analysis.ts` | Zod contracts |
| `lib/vision/processor.ts` | Phase 0 chart OCR |
| `lib/data/ingestion.ts` | Twelve Data / FRED / News (no mocks) |
| `lib/agents/definitions.ts` | 10 specialist prompts |
| `lib/execution/runner.ts` | Rate-limited isolated batch runner (2/batch + 3s, 429 backoff) |
| `lib/llm/models.ts` | Live model catalogs; retired Gemini 2.0 ids are never called |
| `lib/llm/client.ts` | Multi-provider LLM client (openrouter → nvidia → gemini) with per-provider model fallback |
| `lib/llm/json.ts` | Robust JSON extraction + normalization |
| `lib/debate/engine.ts` | Round 2 debate |
| `lib/judge/chief_judge.ts` | 11th judge |
| `lib/quant/sizing.ts` | Pip / lot math from instrument specs |
| `lib/pipeline/analyze.ts` | Orchestrator (events, freeze, hard guard, sizing) |
| `lib/db/store.ts` | File-backed session/health store |
| `app/api/analyze/route.ts` | Controller (JSON or SSE `?stream=1`) |
| `app/dashboard/page.tsx` + `components/terminal/TradingTerminal.tsx` | Terminal UI |

## QA acceptance matrix

| Test | Scenario | Where it lives |
| --- | --- | --- |
| 1 | 4H XAU/USD chart | Phase 0 extracts symbol/TF/price; shown in Vision panel |
| 2 | TF mismatch (15m chart, 4H declared) | `timeframeMismatchWarning` → red banner |
| 3 | Full council | Exactly 10 agents, batches of 2 + 3s stagger, live A1–A10 progress grid |
| 4 | Schema enforcement | `AgentOutputSchema.parse` + normalization; failures → explicit NO_TRADE/INSUFFICIENT fallback |
| 5 | Debate synthesis | Top bull/bear claims confronted (2-turn) |
| 6 | Chief Judge verdict | Independent BUY/SELL/NO_TRADE (separate provider chain) |
| 7 | Vote distribution | Exact counts rendered |
| 8 | Votes ≠ probability | UI labels counts "never interpreted as probability of profit"; judge card says "Not a win-rate" |
| 9 | API failure / missing key | `DATA_UNAVAILABLE` states end-to-end; hard guard refuses zero-data runs; zero mock data |
| 10 | Sizing math | `lib/quant/sizing.ts` — Risk / (SL pips × pip value per lot) |
| 11 | Outcome logging | `POST /api/sessions/:id/outcome` stores outcome; rules never altered |
| 12 | Immutable re-run | Same screenshot hash → frozen replay (`reusedFrozenSession: true`), zero live API calls |

## Mandate

- Agent vote counts are **counts**, never a probability of profit.
- `NO_TRADE` is first-class.
- Stop loss must come from structure, not arbitrary percentages.
- Outcome logging (WIN/LOSS) never rewrites decision rules.
- The terminal never executes trades.

## Disclaimer

Trading AI AK is a personal decision-support tool, not financial advice. Verify every level on your own chart before acting.
