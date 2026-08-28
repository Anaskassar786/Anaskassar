import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_DEFINITIONS } from '@/lib/agents/definitions';
import {
  agentWantsChart,
  buildBatchSystemPrompt,
  parseBatchResponse,
  planAgentBatches,
  plannedRequestCount
} from '@/lib/execution/batching';

describe('planAgentBatches — the request-count fix for free-tier 429s', () => {
  it('turns 10 specialists into 3 requests at the default batch size', () => {
    const groups = planAgentBatches(AGENT_DEFINITIONS, 5);
    assert.equal(plannedRequestCount(groups), 3);
    assert.equal(groups.flatMap((g) => g.agents).length, 10, 'no specialist may be dropped');
    const numbers = groups.flatMap((g) => g.agents.map((a) => a.number)).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('keeps the chart-blind macro/news specialists in their own image-free batch', () => {
    const groups = planAgentBatches(AGENT_DEFINITIONS, 5);
    const textOnly = groups.filter((g) => !g.needsChart);
    assert.equal(textOnly.length, 1);
    assert.deepEqual(textOnly[0].agents.map((a) => a.number), [8, 9]);
    assert.equal(groups.filter((g) => g.needsChart).every((g) => g.agents.every(agentWantsChart)), true);
  });

  it('size 1 restores the legacy one-request-per-agent behaviour', () => {
    assert.equal(plannedRequestCount(planAgentBatches(AGENT_DEFINITIONS, 1)), 10);
    assert.equal(plannedRequestCount(planAgentBatches(AGENT_DEFINITIONS, 0)), 10, 'a bogus size must not lose agents');
  });

  it('carries every brief, fenced per specialist, into one system prompt', () => {
    const [group] = planAgentBatches(AGENT_DEFINITIONS, 5);
    const prompt = buildBatchSystemPrompt(group);
    for (const a of group.agents) {
      assert.ok(prompt.includes(`AGENT ${a.number} — ${a.name}`), `brief for A${a.number} missing`);
    }
    assert.match(prompt, /Do NOT harmonise/i, 'independence must be stated explicitly');
    assert.match(prompt, /NEVER invent prices/i, 'the no-fabrication mandate must survive batching');
  });
});

describe('parseBatchResponse — attribution is never guessed', () => {
  const group = planAgentBatches(AGENT_DEFINITIONS, 5)[0];

  it('maps answers back by agent_number, not by position', () => {
    const shuffled = [...group.agents].reverse().map((a) => ({ agent_number: a.number, decision: 'BUY', stop_loss: a.number }));
    const parsed = parseBatchResponse({ agents: shuffled }, group);
    assert.equal(parsed.missing.length, 0);
    for (const a of group.agents) {
      assert.equal(parsed.byAgent.get(a.number)?.stop_loss, a.number);
    }
  });

  it('reports omitted specialists instead of inventing them', () => {
    const some = group.agents.slice(0, 2).map((a) => ({ agent_number: a.number, decision: 'SELL' }));
    const parsed = parseBatchResponse({ agents: some }, group);
    assert.equal(parsed.byAgent.size, 2);
    assert.deepEqual(parsed.missing, group.agents.slice(2).map((a) => a.number));
  });

  it('accepts the map, array and results-wrapper shapes models actually emit', () => {
    const first = group.agents[0].number;
    assert.equal(parseBatchResponse([{ agent_number: first, decision: 'BUY' }], group).byAgent.size, 1);
    assert.equal(parseBatchResponse({ results: [{ agent_number: first, decision: 'BUY' }] }, group).byAgent.size, 1);
    assert.equal(parseBatchResponse({ [`A${first}`]: { decision: 'BUY' } }, group).byAgent.size, 1);
  });

  it('resolves an unlabelled answer only when a single specialist was asked', () => {
    const solo = planAgentBatches([AGENT_DEFINITIONS[0]], 5)[0];
    assert.equal(parseBatchResponse({ decision: 'BUY', confidence: 70 }, solo).byAgent.size, 1);
    const ambiguous = parseBatchResponse({ decision: 'BUY', confidence: 70 }, group);
    assert.equal(ambiguous.byAgent.size, 0, 'an unattributable answer must never be assigned to a specialist');
  });

  it('ignores agents that were not part of this batch', () => {
    const parsed = parseBatchResponse({ agents: [{ agent_number: 99, decision: 'BUY' }] }, group);
    assert.equal(parsed.byAgent.size, 0);
    assert.equal(parsed.missing.length, group.agents.length);
  });
});
