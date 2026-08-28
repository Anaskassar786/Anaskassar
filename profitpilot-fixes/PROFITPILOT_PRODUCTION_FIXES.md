# ProfitPilot-Ai — 3 production fixes (OpenRouter models / TLS / Postgres SSL)

Date verified: **2026-08-28**. Target repo: `Anaskassar786/ProfitPilot-Ai`
(branch `fix/openrouter-models-tls-ssl`, commit `b9c6a2b`).

> **Note on the deployment platform:** the issues were reported as "Railway", but
> the project now runs on **Render**. Problems 2 and 3 are Render **environment
> variable** changes — no code in the repo sets `NODE_TLS_REJECT_UNAUTHORIZED`
> or `sslmode`, so the dashboard is the source of truth. The code changes in
> this patch are the safety net that makes those settings impossible to get
> wrong silently.

## How to apply

```bash
cd path/to/ProfitPilot-Ai
git checkout main && git pull
git checkout -b fix/openrouter-models-tls-ssl

# Option A — apply as a real commit (recommended, keeps author + message)
git am /path/to/profitpilot-openrouter-tls-ssl.patch

# Option B — apply without committing
git apply /path/to/profitpilot-openrouter-tls-ssl.patch

pnpm install && pnpm build && pnpm typecheck && pnpm test
git push -u origin fix/openrouter-models-tls-ssl
```

The patch was validated with `git apply --check` **and** a full `git am` against
a clean clone of `main` — it reproduces all 12 changed/added files exactly.

---

## Problem 1 — every configured OpenRouter model was unavailable

### What was actually wrong

Every candidate was checked live against
`https://openrouter.ai/api/v1/models/{id}/endpoints`. A model is only usable
when that call returns **at least one endpoint**; `validateModels()` in
`packages/ai/src/provider.ts` marks anything else `no_endpoints` (HTTP 200 with
an empty list) or `not_found` (HTTP 404).

The entire **2025 `:free` generation is gone**. Every one of these returns an
empty endpoint list today:

| Slug | Result |
| --- | --- |
| `meta-llama/llama-3.1-8b-instruct:free` | `no_endpoints` |
| `meta-llama/llama-3.3-70b-instruct:free` | `no_endpoints` |
| `qwen/qwen3-coder:free` | `no_endpoints` |
| `deepseek/deepseek-chat-v3-0324:free` | `no_endpoints` |
| `openai/gpt-oss-20b:free` | `no_endpoints` |
| `z-ai/glm-4.5-air:free` | `no_endpoints` |
| `qwen/qwen3-next-80b-a3b-instruct:free` | `no_endpoints` |
| `arcee-ai/trinity-large-preview:free` | `no_endpoints` |
| `liquid/lfm-2.5-1.2b-instruct:free` | `no_endpoints` |
| `google/gemma-2-9b-it:free` | `no_endpoints` |
| `nvidia/nemotron-3-nano-30b-a3b:free` | `no_endpoints` |
| `nvidia/nemotron-3-nano-omni:free` | **404** `not_found` |

`AI_MODEL_PRIMARY=LiquidAI: LFM2.5-Embedding-350M` is not a chat model at all
(it is an embedding model, and the id is not a valid OpenRouter slug) — 404.

### The replacement set (verified ACTIVE 2026-08-28)

| Slug | Provider | Context | Uptime (30m) |
| --- | --- | --- | --- |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nvidia | 262,144 | 99.61% |
| `google/gemma-4-26b-a4b-it:free` | Google AI Studio | 262,144 | 100% |
| `inclusionai/ling-3.0-flash-fin:free` | Novita | 262,144 | 100% |
| `cohere/north-mini-code:free` | Cohere | 256,000 | 97.82% |

Spare, also active: `dots-studio/dots-3-note-preview:free` (AtlasCloud, 512K
context) — usable as a fourth slot, but it is a preview model that expires
**2026-09-30**, so it is not used as a default.

Each slot resolves on a **different provider**, so a single provider going down
can no longer take out the whole fallback chain.

### Changes

`.env.example`:

| Variable | Before | After |
| --- | --- | --- |
| `AI_MODEL_PRIMARY` | `nvidia/nemotron-3-super-120b-a12b:free` | unchanged (verified active) |
| `AI_MODEL_FALLBACK1` | `google/gemma-4-26b-a4b-it:free` | unchanged (verified active) |
| `AI_MODEL_FALLBACK2` | `nvidia/nemotron-3-nano-30b-a3b:free` ❌ | `inclusionai/ling-3.0-flash-fin:free` ✅ |
| `AI_COMMAND_MODEL_PRIMARY` | `cohere/north-mini-code:free` | unchanged (verified active) |
| `AI_COMMAND_MODEL_FALLBACK` | `nvidia/nemotron-3-nano-30b-a3b:free` ❌ | `google/gemma-4-26b-a4b-it:free` ✅ |

`docs/AI_COMMAND.md` documented the same two dead slugs
(`meta-llama/llama-3.3-70b-instruct:free` and `google/gemma-2-9b-it:free`) —
both corrected.

`apps/api/src/f8-bootstrap.ts` was reviewed and needs **no change**. It already
validates every configured model at every boot and emits exactly the log line
the verification asks for:

```
OpenRouter model validated            { model, status_code }   ← per healthy model
STARTUP ALERT: OpenRouter model slug is invalid or has no active endpoints  ← per dead model
STARTUP ALERT: every configured OpenRouter model is unavailable              ← only if ALL dead
```

Fixing the slugs is what makes that first line appear; nothing was wrong with
the check itself.

> **Finding:** `AI_COMMAND_MODEL_PRIMARY` / `AI_COMMAND_MODEL_FALLBACK` are not
> read by any code path. The AI Command Center answers deterministically from
> tool output and reuses the shared `AI_MODEL_*` provider for prose formatting
> only. They are now on verified-active slugs and marked reserved in
> `.env.example`, so nobody copies a dead id when they are eventually wired up.

---

## Problem 2 — `NODE_TLS_REJECT_UNAUTHORIZED=0`

`=0` disables TLS certificate verification **process-wide**: every outbound
HTTPS call (OpenRouter, Shopify Admin API, Upstash, Sentry, Postgres over TLS)
silently accepts a forged certificate. Node also prints its own warning the
first time it is used.

**No code in the repo sets it** — it is purely a Render environment variable.

Two-part fix:

1. **Render dashboard (required):** delete `NODE_TLS_REJECT_UNAUTHORIZED` from
   the environment / env group (or set it to `1`). Redeploy after.
2. **Code (safety net):** new `enforceSecureTls()` in
   `packages/monitoring/src/tls.ts`, called at the top of
   `apps/api/src/main.ts` and `apps/worker/src/main.ts`. If the variable is
   still `0`, it is restored to `1` before any socket is opened and an error is
   logged.

Node re-reads `process.env.NODE_TLS_REJECT_UNAUTHORIZED` **lazily at connect
time**, so restoring it at startup really does re-secure later connections. This
was proved against a live self-signed TLS server:

```
before guard : ACCEPTED (cert NOT verified)   + Node's insecurity warning printed
guard fired  : true
after  guard : REJECTED (DEPTH_ZERO_SELF_SIGNED_CERT)
```

---

## Problem 3 — Postgres SSL mode warning

### Root cause (exact)

`node_modules/.pnpm/pg-connection-string@2.14.0/.../index.js:222` — reached
whenever `new Pool({ connectionString })` parses a `DATABASE_URL` containing
`sslmode=prefer`, `sslmode=require` or `sslmode=verify-ca` (unless
`uselibpqcompat=true` is also set).

This is not cosmetic. In **pg v9** those modes stop being aliases of
`verify-full` and adopt libpq semantics — `require` stops verifying the server
certificate entirely. A connection string left on `sslmode=require` therefore
silently downgrades from *verified TLS* to *encrypted but unauthenticated TLS*
on the next major upgrade.

### Fix

1. **Render dashboard (required):** set `DATABASE_URL` to end with
   `?sslmode=verify-full` (keep the rest of the string identical).
2. **Code (safety net):** `normalizePostgresSslMode()` in
   `packages/db/src/config.ts` rewrites `prefer|require|verify-ca` →
   `verify-full` inside `databaseConfigFromEnv()`, and `PostgresDatabase` logs a
   warning naming the mode it replaced. `uselibpqcompat=true` is respected as an
   explicit opt-out. Other query parameters and the credentials in the base URL
   are preserved byte-for-byte.

Verified against the real `pg` code path (`new ConnectionParameters(url)`):

```
BEFORE  sslmode=require    -> 1 warning: "SECURITY WARNING: The SSL modes 'prefer', 'require', ..."
AFTER   sslmode=verify-full-> 0 warnings
```

---

## Verification

| Check | Result |
| --- | --- |
| `pnpm build` | ✅ all 20 workspace projects |
| `pnpm typecheck` | ✅ clean |
| `pnpm test` | ✅ **256 files / 3320 tests passed**, 1 skipped |
| New tests | ✅ `packages/db/src/config.test.ts` (10), `packages/monitoring/src/tls.test.ts` (6) |

End-to-end startup-validation replay, using the live endpoint payloads captured
from OpenRouter and the real `OpenRouterClient.validateModels()`:

```
BEFORE:  LFM2.5-Embedding-350M            UNAVAILABLE (not_found)
         nemotron-3-nano-omni:free        UNAVAILABLE (not_found)
         llama-3.1-8b-instruct:free       UNAVAILABLE (no_endpoints)
AFTER:   nemotron-3-super-120b-a12b:free  OpenRouter model validated
         gemma-4-26b-a4b-it:free          OpenRouter model validated
         ling-3.0-flash-fin:free          OpenRouter model validated
```

### After deploying, Render logs should show

Present, one per model:

```
OpenRouter model validated
```

Absent:

```
every configured OpenRouter model is unavailable
NODE_TLS_REJECT_UNAUTHORIZED
SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca'
```

### Render environment checklist

| Variable | Action |
| --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED` | **Delete** (or set to `1`) |
| `DATABASE_URL` | `...?sslmode=verify-full` |
| `AI_MODEL_PRIMARY` | `nvidia/nemotron-3-super-120b-a12b:free` |
| `AI_MODEL_FALLBACK1` | `google/gemma-4-26b-a4b-it:free` |
| `AI_MODEL_FALLBACK2` | `inclusionai/ling-3.0-flash-fin:free` |
| `AI_COMMAND_MODEL_PRIMARY` | `cohere/north-mini-code:free` |
| `AI_COMMAND_MODEL_FALLBACK` | `google/gemma-4-26b-a4b-it:free` |

Free-tier models rotate constantly, so re-check
`https://openrouter.ai/api/v1/models/{id}/endpoints` before each release.

---

## Files changed

```
.env.example                        | 38 ++
apps/api/src/main.ts                |  4 +
apps/worker/package.json            |  2 +-   (+ @profitpilot/monitoring)
apps/worker/src/main.ts             |  4 +
docs/AI_COMMAND.md                  | 11 +-
packages/db/src/config.ts           | 47 +++++++-   (sslmode normalization)
packages/db/src/config.test.ts      | 60 +++++++++     (new)
packages/db/src/database.ts         |  6 +
packages/monitoring/src/index.ts    |  1 +
packages/monitoring/src/tls.ts      | 39 ++++++      (new — TLS guard)
packages/monitoring/src/tls.test.ts | 39 ++++++      (new)
pnpm-lock.yaml                      |  3 +
```
