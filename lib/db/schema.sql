-- Trading AI AK — PostgreSQL / Supabase DDL
-- Execute this script in your PostgreSQL / Supabase SQL Editor.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS analysis_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    screenshot_url TEXT NOT NULL,
    screenshot_hash VARCHAR(64) NOT NULL,
    user_symbol VARCHAR(20) NOT NULL,
    user_timeframe VARCHAR(10) NOT NULL,
    detected_symbol VARCHAR(20),
    detected_timeframe VARCHAR(10),
    detected_current_price NUMERIC(16, 5),
    timeframe_mismatch_warning BOOLEAN DEFAULT FALSE,
    risk_amount NUMERIC(12, 2) NOT NULL,
    account_balance NUMERIC(12, 2),
    desired_profit NUMERIC(12, 2),
    frozen_market_data JSONB,
    frozen_news_data JSONB,
    frozen_macro_data JSONB,
    status VARCHAR(20) DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'DATA_UNAVAILABLE'))
);

CREATE TABLE IF NOT EXISTS agent_analyses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES analysis_sessions(id) ON DELETE CASCADE,
    agent_number INT NOT NULL CHECK (agent_number BETWEEN 1 AND 10),
    agent_name VARCHAR(50) NOT NULL,
    provider_used VARCHAR(50) NOT NULL,
    model_used VARCHAR(100) NOT NULL,
    decision VARCHAR(10) NOT NULL CHECK (decision IN ('BUY', 'SELL', 'NO_TRADE')),
    confidence INT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    supporting_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
    contradicting_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
    entry_low NUMERIC(16, 5),
    entry_high NUMERIC(16, 5),
    stop_loss NUMERIC(16, 5),
    take_profit_1 NUMERIC(16, 5),
    take_profit_2 NUMERIC(16, 5),
    take_profit_3 NUMERIC(16, 5),
    risk_reward NUMERIC(6, 2),
    invalidation_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    data_quality VARCHAR(20) NOT NULL CHECK (data_quality IN ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT')),
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_debates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES analysis_sessions(id) ON DELETE CASCADE,
    vote_summary JSONB NOT NULL,
    top_bullish_claim JSONB NOT NULL,
    top_bearish_claim JSONB NOT NULL,
    bull_counterargument TEXT NOT NULL,
    bear_counterargument TEXT NOT NULL,
    synthesis_conclusion TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS final_decisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL UNIQUE REFERENCES analysis_sessions(id) ON DELETE CASCADE,
    chief_judge_model VARCHAR(100) NOT NULL,
    final_decision VARCHAR(10) NOT NULL CHECK (final_decision IN ('BUY', 'SELL', 'NO_TRADE')),
    vote_buy_count INT NOT NULL,
    vote_sell_count INT NOT NULL,
    vote_no_trade_count INT NOT NULL,
    final_confidence INT NOT NULL CHECK (final_confidence BETWEEN 0 AND 100),
    entry_low NUMERIC(16, 5),
    entry_high NUMERIC(16, 5),
    stop_loss NUMERIC(16, 5),
    tp1 NUMERIC(16, 5),
    tp2 NUMERIC(16, 5),
    tp3 NUMERIC(16, 5),
    risk_amount NUMERIC(12, 2) NOT NULL,
    calculated_position_size NUMERIC(12, 4),
    risk_reward NUMERIC(6, 2),
    decision_summary TEXT NOT NULL,
    strongest_bullish_arguments JSONB NOT NULL DEFAULT '[]'::jsonb,
    strongest_bearish_arguments JSONB NOT NULL DEFAULT '[]'::jsonb,
    rejected_arguments JSONB NOT NULL DEFAULT '[]'::jsonb,
    invalidation_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    data_quality VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_outcomes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL UNIQUE REFERENCES analysis_sessions(id) ON DELETE CASCADE,
    outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN', 'SKIPPED')),
    actual_entry NUMERIC(16, 5),
    actual_exit NUMERIC(16, 5),
    actual_pnl NUMERIC(12, 2),
    notes TEXT,
    post_analysis_review TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_health_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_name VARCHAR(50) NOT NULL,
    endpoint_tested VARCHAR(255) NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('PASS', 'FAIL')),
    latency_ms INT NOT NULL,
    error_message TEXT,
    tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
