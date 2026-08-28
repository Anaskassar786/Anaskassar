/**
 * Council health classification.
 *
 * The old behaviour was indistinguishable from a real verdict: a dead LLM
 * provider produced `NO_TRADE` from all 10 specialists, and the terminal showed
 * "Chief Judge Final Decision: NO_TRADE · 10 NO TRADE" as if a council had
 * deliberated. 10 offline agents are not 10 votes for no-trade — they are zero
 * votes, and the run must be labelled as an outage.
 *
 * Pure module (type-only imports) so the rules are unit-testable and shared by
 * the runner, the pipeline and the terminal.
 */

import type { LlmErrorClass } from '@/lib/llm/models';

export type AgentExecutionState = 'LIVE' | 'OFFLINE';

export interface AgentRuntime {
  provider_used: string;
  model_used: string;
  execution_state: AgentExecutionState;
  error_class: LlmErrorClass | 'NONE';
  attempts: number;
  retry_after_ms: number;
}

export interface CouncilLike {
  execution_state?: AgentExecutionState;
  data_quality?: string;
  provider_used?: string;
  model_used?: string;
}

export interface VoteCounts {
  buy: number;
  sell: number;
  noTrade: number;
  offline: number;
}

/** An agent counts as offline only when *we* failed, not when data was thin. */
export function isOfflineAgent(agent: CouncilLike): boolean {
  if (agent.execution_state === 'OFFLINE') return true;
  // Sessions predating execution_state: these meta markers mean "no LLM answered".
  return agent.provider_used === 'none' || agent.model_used === 'fallback' || agent.model_used === 'none' || agent.model_used === 'skipped';
}

export function liveAgentCount(agents: CouncilLike[]): number {
  return agents.filter((a) => !isOfflineAgent(a)).length;
}

export function offlineAgentCount(agents: CouncilLike[]): number {
  return agents.filter(isOfflineAgent).length;
}

/**
 * Vote distribution over *live* opinions only. Offline specialists are reported
 * separately instead of inflating the NO_TRADE column.
 */
export function voteCountOf(agents: Array<CouncilLike & { decision?: string }>): VoteCounts {
  const counts: VoteCounts = { buy: 0, sell: 0, noTrade: 0, offline: 0 };
  for (const agent of agents) {
    if (isOfflineAgent(agent)) {
      counts.offline += 1;
      continue;
    }
    if (agent.decision === 'BUY') counts.buy += 1;
    else if (agent.decision === 'SELL') counts.sell += 1;
    else counts.noTrade += 1;
  }
  return counts;
}

export type CouncilOutcome = 'HEALTHY' | 'DEGRADED' | 'OUTAGE';

/**
 * What the LLM governor actually saw during a run. Persisted with the session and
 * surfaced in the terminal, because "NO_TRADE" and "the council was offline" have
 * to be distinguishable months later.
 */
export interface ProviderDiagnostics {
  council_state: CouncilOutcome;
  live_agents: number;
  offline_agents: number;
  dominant_error_class: string;
  retry_after_ms: number;
  providers_tried: string[];
  skipped_agents: number;
  remediation: string[];
  run_budget_remaining_ms?: number;
  governor?: unknown;
}

/**
 * HEALTHY: enough specialists answered.
 * DEGRADED: some answered — the judge may still rule, with a coverage warning.
 * OUTAGE: nothing answered — there is no council to judge, so the pipeline must
 * stop before spending more quota on debate/judge calls.
 */
export function councilOutcome(totalAgents: number, liveAgents: number): CouncilOutcome {
  if (totalAgents <= 0) return 'OUTAGE';
  if (liveAgents === 0) return 'OUTAGE';
  if (liveAgents < Math.ceil(totalAgents / 2)) return 'DEGRADED';
  return 'HEALTHY';
}

export interface SkipDecision {
  skip: boolean;
  reason: string;
}

/**
 * Fail-fast rule for a sequential agent batch.
 *
 * `canaryFailuresToTrip = 2`: one transient hiccup retries quietly; two agents
 * in a row dying with a provider-side error means the key is rate limited or
 * dead, and sending 8 more image-heavy requests only deepens the penalty window.
 * Non-provider errors (bad model output, JSON parse) never trip the breaker —
 * those are per-agent problems and the next agent may be fine.
 */
export function shouldSkipRemainingAgents(
  consecutiveProviderFailures: number,
  lastErrorClass: LlmErrorClass | 'NONE',
  canaryFailuresToTrip = 2
): SkipDecision {
  const providerSide =
    lastErrorClass === 'RATE_LIMIT' ||
    lastErrorClass === 'AUTH' ||
    lastErrorClass === 'MISSING_KEY' ||
    lastErrorClass === 'CREDITS' ||
    lastErrorClass === 'NETWORK' ||
    lastErrorClass === 'UPSTREAM' ||
    lastErrorClass === 'TIMEOUT';
  if (!providerSide) return { skip: false, reason: '' };
  if (consecutiveProviderFailures < canaryFailuresToTrip) return { skip: false, reason: '' };
  const label =
    lastErrorClass === 'RATE_LIMIT'
      ? 'LLM provider rate limited'
      : lastErrorClass === 'MISSING_KEY'
        ? 'no LLM provider key configured'
        : lastErrorClass === 'AUTH'
          ? 'LLM provider rejected the API key'
          : lastErrorClass === 'CREDITS'
            ? 'LLM provider account out of credits'
            : `LLM provider ${lastErrorClass.toLowerCase()}`;
  return { skip: true, reason: `${label} — ${consecutiveProviderFailures} consecutive failures` };
}

/** The offline record the runner stores for a specialist that never got an answer. */
export function offlineEvidence(reason: string, errorClass: LlmErrorClass): { evidence: string; warning: string } {
  const human =
    errorClass === 'RATE_LIMIT'
      ? 'LLM provider rate limited (HTTP 429) — this specialist never ran, so it holds no opinion'
      : errorClass === 'MISSING_KEY'
        ? 'no LLM provider key configured — this specialist never ran'
        : errorClass === 'AUTH'
          ? 'LLM provider rejected the API key — this specialist never ran'
          : errorClass === 'CREDITS'
            ? 'LLM provider out of credits — this specialist never ran'
            : errorClass === 'TIMEOUT'
              ? 'LLM provider timed out — this specialist never ran'
              : errorClass === 'MODEL_NOT_FOUND'
                ? 'configured model id is unavailable — this specialist never ran'
              : errorClass === 'UPSTREAM'
                ? 'LLM provider upstream error — this specialist never ran'
                  : 'LLM provider error — this specialist never ran';
  return { evidence: `${human}. Raw: ${reason}`.slice(0, 600), warning: 'Agent did not run — no vote' };
}

/**
 * Terminal status for a finished run. Kept pure so the rule "an offline council is
 * an outage, not a NO_TRADE verdict" is enforced by one tested line instead of
 * being buried in the orchestrator.
 */
export type RunStatus = 'COMPLETED' | 'PARTIAL' | 'DATA_UNAVAILABLE' | 'PROVIDER_OUTAGE';

export function runStatusFor(input: { council: CouncilOutcome; dataUnavailable: boolean }): RunStatus {
  if (input.council === 'OUTAGE') return 'PROVIDER_OUTAGE';
  if (input.dataUnavailable) return 'DATA_UNAVAILABLE';
  if (input.council === 'DEGRADED') return 'PARTIAL';
  return 'COMPLETED';
}

/**
 * What an operator must actually do, derived from the dominant error class.
 * Never a "please retry later" dead end when the real problem is a missing key.
 */
export function remediationFor(errorClass: LlmErrorClass, retryAfterMs: number, providers: string[]): string[] {
  const out: string[] = [];
  const primary = providers[0] || 'nvidia';
  switch (errorClass) {
    case 'RATE_LIMIT': {
      const wait = retryAfterMs > 0 ? `~${Math.ceil(retryAfterMs / 1000)}s` : 'a minute or two';
      out.push(`Wait ${wait} for the free-tier window to reset, then re-run (the failed run is never frozen, so the same screenshot works).`);
      out.push(
        `Spread the load: keep ${primary} first but set LLM_PROVIDER_ORDER=${primary},openrouter,gemini and add OPENROUTER_API_KEY / GEMINI_API_KEY so a 429 on one key cannot take the whole council down.`
      );
      out.push(
        `Cut request COUNT, which matters more than size on free tiers: LLM_AGENT_BATCH_SIZE=5 runs the 10 specialists in 3 requests instead of 10 (set it to 3 for ~4 requests if answers get truncated).`
      );
      out.push(`Cut prompt size: smaller screenshots (max LLM_IMAGE_MAX_EDGE=1400) and LLM_AGENTS_ATTACH_CHART=false drop the token count that triggers 429s.`);
      out.push('Tune the governor if the account legitimately allows more: LLM_MAX_ATTEMPTS, LLM_MIN_INTERVAL_MS, LLM_RUN_BUDGET_MS.');
      break;
    }
    case 'MISSING_KEY':
    case 'AUTH':
      out.push(`Set a valid API key for the configured provider (${errorClass === 'MISSING_KEY' ? 'key is absent' : 'key was rejected'}) and restart the dev server.`);
      out.push('Run GET /api/health — it probes each provider key and reports which one is invalid.');
      break;
    case 'CREDITS':
      out.push('Top up the LLM account, or lower LLM_MAX_TOKENS so the completion reservation fits the balance.');
      break;
    case 'MODEL_NOT_FOUND':
      out.push('Fix the model id: NVIDIA_DEFAULT_MODEL / OPENROUTER_DEFAULT_MODEL / GEMINI_DEFAULT_MODEL point at models that no longer exist.');
      break;
    case 'TIMEOUT':
    case 'NETWORK':
      out.push('Network or provider timeout: raise per-call patience with LLM_MAX_WAIT_MS, or re-run when the provider is reachable.');
      break;
    default:
      out.push('Provider returned an unclassified error — check the raw error text in the agent cards, then re-run.');
  }
  return out;
}
