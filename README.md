# Trading AI AK

Private personal multi-agent **position trading decision-support** terminal for spot gold (XAU/USD) and major/minor FX.

This system is **not a broker**. It has **no execution capability**. It must **never fabricate** prices, candles, indicators, API responses, backtests, win rates, confidence-as-probability, or news. Failed feeds return `DATA_UNAVAILABLE` / `INSUFFICIENT DATA`; a dead LLM provider returns `PROVIDER_OUTAGE` — explicitly *not* a trading verdict.

## Architecture

```
User screenshot (downscaled in the browser) + risk inputs
        → Phase 0  Vision OCR (symbol, TF, price) — impatient probe, fails fast
        → Phase 1  Immutable freeze (Twelve Data, FRED, News)
        → HARD GUARD: zero data (feeds + vision) → DATA_UNAVAILABLE / PROVIDER_OUTAGE,
                   council never runs
        → Phase 2  10 isolated specialists, serial, under a shared rate governor
                   (canary agent is patient and waits out Retry-After; if 2 agents in
                   a row die for provider reasons the rest are recorded OFFLINE and
                   no further request is sent)
        → Phase 3  Bull vs Bear adversarial debate (live opinions only)
        → Phase 4  11th Chief Judge + position sizing, with a local refusal guard
                   when the council never ran
        → Terminal dashboard + session storage (+ provider diagnostics per run)
```

Every LLM call (vision, 10 specialists, debate, judge) shares one governor
(`lib/llm/rate-limit.ts`): a process-wide minimum gap, a concurrency gate,
per-provider cooldowns taken from the provider's own `Retry-After`, and an outage
breaker. This is what stops one free-tier 429 from being reported as a
unanimous NO_TRADE.

## Quick start

```bash
cp .env.example .env.local   # fill server-side keys only
npm install
npm run dev                  # http://localhost:3000 → /dashboard
npm test                     # unit + integration tests: rate governor, provider
                             # failover, outage labelling, batch scheduling
```

Never expose API keys to the browser. `.env.local` is gitignored.

### `.env.local` — what you fill (NVIDIA-only council)

Copy `.env.example` then paste **your** keys. Do not commit this file.

```bash
# REQUIRED — council (vision + 10 agents + debate + judge)
NVIDIA_API_KEY=nvapi-YOUR_KEY_HERE
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_DEFAULT_MODEL=minimaxai/minimax-m3
LLM_PROVIDER_ORDER=nvidia
LLM_MAX_TOKENS=4096

# REQUIRED for live market freeze (otherwise DATA_UNAVAILABLE on that feed)
TWELVE_DATA_API_KEY=YOUR_TWELVE_DATA_KEY
TWELVE_DATA_BASE_URL=https://api.twelvedata.com
FRED_API_KEY=YOUR_FRED_KEY
FRED_BASE_URL=https://api.stlouisfed.org/fred
NEWS_API_KEY=YOUR_NEWSAPI_KEY
NEWS_API_BASE_URL=https://newsapi.org

NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`OPENROUTER_API_KEY` / `GEMINI_API_KEY` may stay empty — nothing is called or billed
that you have not keyed. With `LLM_FAILOVER=on` (default) any provider that *does*
have a key is appended as a fallback tail after your preferred one, so a 429 on a
single free-tier key degrades to "one provider is slow" instead of "the whole council
is dead". Set `LLM_FAILOVER=off` for strict single-provider behaviour.

## Environment variables (`.env.local`)

All keys are **server-side only** — nothing is `NEXT_PUBLIC_*` except `NEXT_PUBLIC_APP_URL`.

| Variable | Used by | If missing |
| --- | --- | --- |
| `NVIDIA_API_KEY` | **Required for council** — vision, 10 agents, debate, Chief Judge | All LLM calls fail honest `NO_TRADE` / `INSUFFICIENT` |
| `NVIDIA_BASE_URL` | NVIDIA OpenAI-compatible host | Defaults to `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_DEFAULT_MODEL` | NIM model id | Defaults to `minimaxai/minimax-m3` |
| `LLM_PROVIDER_ORDER` | Preferred LLM backends, in order | Defaults to `nvidia`; other keyed providers are appended as failover |
| `LLM_FAILOVER` | `on` / `off` — append other keyed providers automatically | `on`. `off` = strict single provider |
| `LLM_MIN_INTERVAL_MS` | Process-wide minimum gap between LLM requests | `900` |
| `LLM_MAX_CONCURRENCY` | LLM requests in flight at once | `1` (serial — safest for free tiers) |
| `LLM_MAX_ATTEMPTS` | Attempts per provider for 429 / timeout / 5xx | `3` (max 6) |
| `LLM_MAX_WAIT_MS` | Longest one call waits out a `Retry-After` window | `90000` |
| `LLM_MAX_COOLDOWN_MS` | Ceiling for a single provider cooldown | `120000` |
| `LLM_OUTAGE_THRESHOLD` | Consecutive provider faults before the breaker opens | `3` |
| `LLM_RUN_BUDGET_MS` | Wall-clock budget for all LLM work in a run | `240000` (keep below route `maxDuration`) |
| `LLM_AGENT_MAX_TOKENS`, `LLM_AGENT_TIMEOUT_MS`, `LLM_MARKET_CANDLES`, `LLM_NEWS_ITEMS` | Per-specialist request shape | `2048`, `55000`, `12`, `5` |
| `LLM_AGENTS_ATTACH_CHART` | Send the screenshot to the 8 chart agents | `true`; `false` = text-only council during a quota crunch |
| `LLM_IMAGE_MAX_BYTES` | Above this, specialists run text-only instead of blowing the token budget | `1500000` |
| `MAX_UPLOAD_BYTES` | Server-side upload guard (413 with instructions) | `12582912` |
| `LLM_MAX_TOKENS` | Completion cap (stops OpenRouter 65k/402 reservation) | Defaults to `4096` |
| `OPENROUTER_API_KEY` (+ `_BASE_URL`, `_DEFAULT_MODEL`, `_FALLBACK_MODELS`) | Optional failover only if listed in `LLM_PROVIDER_ORDER` | Ignored when order is `nvidia` |
| `GEMINI_API_KEY` (+ `_BASE_URL`, `_DEFAULT_MODEL`, `_FALLBACK_MODELS`) | Optional failover only if listed in `LLM_PROVIDER_ORDER` | Ignored when order is `nvidia` |
| `MINIMAX_API_KEY` / `MINIMAX_DEFAULT_MODEL` | Reserved (MiniMax is routed via NVIDIA) | Unused |
| `TWELVE_DATA_API_KEY` (+ `_BASE_URL`) | Market candles (Phase 1 freeze) | `DATA_UNAVAILABLE` market feed |
| `FRED_API_KEY` (+ `_BASE_URL`) | Macro — FEDFUNDS (Phase 1 freeze) | `DATA_UNAVAILABLE` macro feed |
| `NEWS_API_KEY` (+ `_BASE_URL`) | Headlines (Phase 1 freeze) | `DATA_UNAVAILABLE` news feed |
| `NEXT_PUBLIC_APP_URL` | App base URL (and OpenRouter referer if enabled) | Defaults to `http://localhost:3000` |
| `DATABASE_URL` | **Optional / reserved** — this checkout persists to the file store under `data/` | File store is used |

> ⚠ Gemini 2.0 Flash (`gemini-2.0-flash`, `google/gemini-2.0-flash-001`) is **retired**. If your `.env.local` still points at those ids the client skips them and uses Gemini 3.6 / 3.5 / 2.5 Flash instead. A failed council run (all agents `fallback`) is **not** frozen for replay, so you can re-run after keys/models recover.
>
> ⚠ OpenRouter **402** (`requested up to 65536 tokens, but can only afford N`) is a **credit reservation** bug if `max_tokens` is omitted. The client now always sends `max_tokens` (default 4096 via `LLM_MAX_TOKENS`). Gemini/NVIDIA **429** trips a short cooldown so the next agents do not keep burning the free-tier quota. Add OpenRouter credits if the balance is actually empty.
>
> ⚠ The `MINIMAX_API_KEY` shipped in the original spec appears to contain an embedded `Bearer` prefix (copy artifact). It is unused today; fix it in your key registry if you plan to route MiniMax directly.

> 🔐 **Secrets hygiene.** `.env.local` is gitignored and untracked. If it was ever committed, assume every key in it is public: rotate the NVIDIA / Twelve Data / FRED / News API keys, and purge the blob from history (`git filter-repo --path .env.local --invert-paths`) before making the repo visible.

## When a run comes back `PROVIDER_OUTAGE`

This is a deliberately **non-decision**: it means no specialist reached a model, so there was nothing to judge. It is *not* a NO_TRADE verdict, offline agents are *not* votes, and the run is never frozen for replay — re-run the same screenshot once the provider recovers.

| Symptom | Meaning | Do this |
| --- | --- | --- |
| `RATE_LIMIT` on one provider, others keyed | free-tier window exhausted | already handled — the client fails over; also drop `LLM_IMAGE_MAX_BYTES` / set `LLM_AGENTS_ATTACH_CHART=false` |
| `RATE_LIMIT`, only one provider keyed | a single key gates the whole terminal | add `OPENROUTER_API_KEY` or `GEMINI_API_KEY`, or set `LLM_PROVIDER_ORDER=nvidia,openrouter,gemini` |
| `MISSING_KEY` / `AUTH` | no key / rejected key | `GET /api/health` names the broken key; `?probe=1` spends 1 token per provider to test quota too |
| `CREDITS` (OpenRouter 402) | balance below the reservation | lower `LLM_MAX_TOKENS`, top up, or move to a keyed free tier |
| `MODEL_NOT_FOUND` | env points at a retired model id | fix `*_DEFAULT_MODEL`; retired Gemini 2.0 ids are skipped automatically |
| `TIMEOUT` / `NETWORK` | provider unreachable | raise `LLM_MAX_WAIT_MS`, or re-run; the terminal will not substitute anything |

The session record keeps `provider_diagnostics` (live/offline agents, dominant error class, retry window, providers tried, breaker state) so an outage is explainable months later.

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
| `lib/execution/runner.ts` | Specialist scheduler (canary + fail-fast, chart-size-aware) |
| `lib/execution/offline.ts` | Offline vs NO_TRADE labelling, council outcome, remediation text |
| `lib/llm/rate-limit.ts` | Shared governor: pacing, `Retry-After` cooldowns, outage breaker, run budget |
| `lib/image/downscale.ts` | Browser-side screenshot downscale (token/429 control) |
| `lib/llm/models.ts` | Live model catalogs; retired Gemini 2.0 ids never called; error classification; failover order |
| `lib/llm/client.ts` | LLM client — governor-driven retries, provider failover, `LlmUnavailableError` |
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
| 9 | API failure / missing key | `DATA_UNAVAILABLE` / `PROVIDER_OUTAGE` end-to-end; hard guard refuses zero-data runs; zero mock data |
| 13 | Provider 429 during a run | governor backs off using `Retry-After`, retries ≤ `LLM_MAX_ATTEMPTS`, then fails over to the next keyed provider; if 2 agents in a row die, the remaining specialists are recorded `OFFLINE` **without** a request (`npm test`) |
| 14 | Offline ≠ NO_TRADE | `voteCountOf` reports `{buy:0,sell:0,noTrade:0,offline:10}`; the terminal shows "COUNCIL OFFLINE", never a fake final decision |
| 10 | Sizing math | `lib/quant/sizing.ts` — Risk / (SL pips × pip value per lot) |
| 11 | Outcome logging | `POST /api/sessions/:id/outcome` stores outcome; rules never altered |
| 12 | Immutable re-run | Same screenshot hash → frozen replay (`reusedFrozenSession: true`), zero live API calls |

## Mandate

- Agent vote counts are **counts**, never a probability of profit.
- `NO_TRADE` is first-class.
- Stop loss must come from structure, not arbitrary percentages.
- Outcome logging (WIN/LOSS) never rewrites decision rules.
- The terminal never executes trades.
- An infrastructure failure is reported as an infrastructure failure — never as a trading decision, and never with fabricated levels to fill the gap.

## Disclaimer

Trading AI AK is a personal decision-support tool, not financial advice. Verify every level on your own chart before acting.
