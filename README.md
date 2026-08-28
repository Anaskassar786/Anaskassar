# Trading AI AK

Private personal multi-agent **position trading decision-support** terminal for spot gold (XAU/USD) and major/minor FX.

This system is **not a broker**. It has **no execution capability**. It must **never fabricate** prices, candles, indicators, API responses, backtests, win rates, confidence-as-probability, or news. Failed feeds return `DATA_UNAVAILABLE` / `INSUFFICIENT DATA`.

## Architecture

```
User screenshot + risk inputs
        → Phase 0  Vision OCR (symbol, TF, price)
        → Phase 1  Immutable freeze (Twelve Data, FRED, News)
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

## PostgreSQL schema

`lib/db/schema.sql` is the production DDL for Supabase / Postgres. The runtime store in this checkout is a file-backed snapshot under `data/` so the terminal works without a live database. Frozen sessions replay from disk and do **not** re-query live APIs.

## Core paths

| Path | Role |
| --- | --- |
| `types/analysis.ts` | Zod contracts |
| `lib/vision/processor.ts` | Phase 0 chart OCR |
| `lib/data/ingestion.ts` | Twelve Data / FRED / News (no mocks) |
| `lib/agents/definitions.ts` | 10 specialist prompts |
| `lib/execution/runner.ts` | Rate-limited isolated batch runner |
| `lib/debate/engine.ts` | Round 2 debate |
| `lib/judge/chief_judge.ts` | 11th judge |
| `lib/quant/sizing.ts` | Pip / lot math from instrument specs |
| `app/api/analyze/route.ts` | Controller (JSON or SSE `?stream=1`) |
| `app/dashboard/page.tsx` | Terminal UI |

## Mandate

- Agent vote counts are **counts**, never a probability of profit.
- `NO_TRADE` is first-class.
- Stop loss must come from structure, not arbitrary percentages.
- Outcome logging (WIN/LOSS) never rewrites decision rules.
