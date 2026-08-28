/**
 * Council batching.
 *
 * ROOT CAUSE OF "COUNCIL OFFLINE — 10/10 OFFLINE (RATE_LIMIT)"
 * -----------------------------------------------------------
 * The council needed 12+ separate completions per run (1 vision + 10
 * specialists + debate/judge). A free-tier key that allows a handful of
 * requests per minute can never satisfy that, so the very first agent ate the
 * quota, agent 2 got a 429, the breaker tripped and the remaining 8 were
 * recorded OFFLINE without ever running. The terminal was *honest* about it,
 * but the run still produced nothing.
 *
 * The fix is to stop treating "one specialist = one HTTP request" as a law.
 * The specialists are independent *analysts*, not independent *requests*: a
 * single call can carry several specialist briefs and return one JSON object
 * per specialist. With the default batch size of 5, a full council costs 2
 * requests instead of 10 — an 80% cut in the exact traffic that triggers the
 * 429 — while every agent still produces its own isolated verdict, evidence
 * and levels.
 *
 * Isolation is preserved by prompt construction: each brief is fenced, agents
 * are told not to reconcile with each other, and the parser maps answers back
 * by `agent_number` (never by position) so a re-ordered or partial answer can
 * never silently attribute one specialist's levels to another.
 *
 * Pure module (type-only imports) so the grouping and parsing rules are
 * unit-testable without a network or a Next runtime.
 */

import type { AgentDefinition } from '@/lib/agents/definitions';

export interface AgentBatchGroup {
  index: number;
  agents: AgentDefinition[];
  /** True when at least one member of the group actually reads the chart. */
  needsChart: boolean;
}

/** Specialists that work purely off frozen feeds — the screenshot is dead weight. */
export const TEXT_ONLY_AGENT_NUMBERS = new Set([8, 9]);

export function agentWantsChart(agent: AgentDefinition): boolean {
  return !TEXT_ONLY_AGENT_NUMBERS.has(agent.number);
}

/**
 * Group specialists into request-sized batches.
 *
 * Chart-reading and text-only specialists are grouped separately so the
 * screenshot is never attached to a request that contains only macro/news
 * briefs — image tokens are the single biggest 429 driver.
 *
 * `size <= 1` restores the legacy one-request-per-agent behaviour.
 */
export function planAgentBatches(agents: AgentDefinition[], size: number): AgentBatchGroup[] {
  const capped = Math.max(1, Math.min(Math.floor(size) || 1, 10));
  const chart = agents.filter(agentWantsChart);
  const textOnly = agents.filter((a) => !agentWantsChart(a));
  const groups: AgentBatchGroup[] = [];

  const push = (list: AgentDefinition[], needsChart: boolean) => {
    for (let i = 0; i < list.length; i += capped) {
      groups.push({ index: groups.length, agents: list.slice(i, i + capped), needsChart });
    }
  };

  push(chart, true);
  push(textOnly, false);
  return groups.map((g, index) => ({ ...g, index }));
}

/** How many outbound requests a plan costs — surfaced in the terminal. */
export function plannedRequestCount(groups: AgentBatchGroup[]): number {
  return groups.length;
}

const BATCH_CONTRACT = `
You are running a panel of independent specialists in a single pass.

HARD RULES:
- Answer EVERY specialist listed below, exactly once.
- Each specialist reasons ONLY within its own mandate. Do NOT harmonise, average
  or reconcile the specialists with one another: disagreement between them is
  expected and valuable, and a fabricated consensus corrupts the vote count.
- NEVER invent prices, candles, indicators, volume, news or macro values that are
  not in the provided snapshot or clearly visible on the chart image. A
  specialist with nothing to read must return data_quality "INSUFFICIENT" and
  decision "NO_TRADE" — that is an honest answer, not a failure.
- confidence is conviction in the analysis (0-100), NEVER a probability of profit.
- stop_loss must be a structural invalidation level, never an arbitrary percentage.

OUTPUT: a single JSON object of the form
{ "agents": [ { ...specialist object... }, ... ] }
with one entry per specialist, each shaped as:
{
  "agent_number": <number, must match the brief>,
  "agent_name": "<NAME from the brief>",
  "decision": "BUY" | "SELL" | "NO_TRADE",
  "confidence": 0-100,
  "evidence": ["..."],
  "supporting_factors": ["..."],
  "contradicting_factors": ["..."],
  "entry_zone": { "low": number|null, "high": number|null },
  "stop_loss": number|null,
  "take_profit_1": number|null,
  "take_profit_2": number|null,
  "take_profit_3": number|null,
  "risk_reward": number|null,
  "invalidation_conditions": ["..."],
  "data_quality": "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT",
  "warnings": ["..."]
}
Return ONLY that JSON object. No markdown, no prose outside JSON.
`;

/** System prompt carrying every brief in the group, fenced per specialist. */
export function buildBatchSystemPrompt(group: AgentBatchGroup): string {
  const briefs = group.agents
    .map(
      (a) => `--- SPECIALIST BRIEF: AGENT ${a.number} — ${a.name} ---
Focus domain: ${a.focusDomain}
Mandate:
${a.systemPrompt.replace(/\n?STRICT OUTPUT RULES:[\s\S]*$/i, '').trim()}
--- END BRIEF: AGENT ${a.number} ---`
    )
    .join('\n\n');

  return `You are the Round 1 specialist panel for Trading AI AK.
${BATCH_CONTRACT}
Specialists to answer in this pass: ${group.agents.map((a) => `A${a.number}`).join(', ')}.

${briefs}`;
}

export interface ParsedBatch {
  /** Raw specialist objects keyed by agent_number. */
  byAgent: Map<number, Record<string, unknown>>;
  /** Agents that were requested but absent from the answer. */
  missing: number[];
}

function coerceRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Map a batched answer back onto the requested specialists.
 *
 * Accepts every shape a model realistically emits: `{agents:[...]}`,
 * `{results:[...]}`, a bare array, a map keyed by `"8"` / `"A8"` / agent name,
 * or — when a single specialist was requested — one flat object. Anything that
 * cannot be attributed with certainty is reported as missing rather than
 * guessed, because attributing agent 3's stop-loss to agent 7 would be a
 * fabrication of exactly the kind this system exists to prevent.
 */
export function parseBatchResponse(raw: unknown, group: AgentBatchGroup): ParsedBatch {
  const wanted = group.agents.map((a) => a.number);
  const byAgent = new Map<number, Record<string, unknown>>();
  const root = coerceRecord(raw);

  const candidates: unknown[] = [];
  if (Array.isArray(raw)) candidates.push(...raw);
  if (root) {
    for (const key of ['agents', 'results', 'specialists', 'outputs', 'analyses', 'panel']) {
      const v = root[key];
      if (Array.isArray(v)) candidates.push(...v);
      else if (coerceRecord(v)) candidates.push(...Object.values(v as Record<string, unknown>));
    }
    if (!candidates.length) {
      // Map form: { "1": {...}, "A2": {...} } or a single flat specialist object.
      const entries = Object.entries(root);
      const mapLike = entries.filter(([k, v]) => /^a?\d{1,2}$/i.test(k.trim()) && coerceRecord(v));
      if (mapLike.length) {
        for (const [k, v] of mapLike) {
          const n = Number(k.replace(/^a/i, ''));
          const rec = coerceRecord(v);
          if (rec && wanted.includes(n)) byAgent.set(n, { ...rec, agent_number: n });
        }
      } else if (root.decision !== undefined || root.confidence !== undefined) {
        candidates.push(root);
      }
    }
  }

  for (const item of candidates) {
    const rec = coerceRecord(item);
    if (!rec) continue;
    let n = Number(rec.agent_number ?? rec.agent ?? rec.number);
    if (!Number.isFinite(n)) {
      const name = String(rec.agent_name ?? '').toUpperCase();
      const match = group.agents.find((a) => name && a.name.toUpperCase() === name);
      n = match ? match.number : NaN;
    }
    // A single-agent request with an unlabelled answer is unambiguous.
    if (!Number.isFinite(n) && wanted.length === 1 && candidates.length === 1) n = wanted[0];
    if (!Number.isFinite(n) || !wanted.includes(n) || byAgent.has(n)) continue;
    byAgent.set(n, { ...rec, agent_number: n });
  }

  return { byAgent, missing: wanted.filter((n) => !byAgent.has(n)) };
}
