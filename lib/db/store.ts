import { promises as fs } from 'fs';
import path from 'path';
import type { AgentOutput, ChiefJudgeOutput, TradeOutcome, VisionParserOutput } from '@/types/analysis';
import type { DebateResult } from '@/lib/debate/engine';
import type { ProviderDiagnostics } from '@/lib/execution/offline';
import type { MacroDataSnapshot, MarketDataSnapshot, NewsDataSnapshot } from '@/lib/data/ingestion';

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const HEALTH_FILE = path.join(DATA_DIR, 'health.json');

export type SessionStatus =
  | 'RUNNING'
  | 'COMPLETED'
  /** Some specialists answered, others never reached a model. */
  | 'PARTIAL'
  | 'FAILED'
  | 'DATA_UNAVAILABLE'
  /** No LLM provider answered at all — no verdict exists, nothing was judged. */
  | 'PROVIDER_OUTAGE';

export interface StoredAgent extends AgentOutput {
  provider_used: string;
  model_used: string;
}

export interface AnalysisSessionRecord {
  id: string;
  created_at: string;
  screenshot_url: string;
  screenshot_hash: string;
  user_symbol: string;
  user_timeframe: string;
  detected_symbol: string;
  detected_timeframe: string;
  detected_current_price: number | null;
  timeframe_mismatch_warning: boolean;
  risk_amount: number;
  account_balance: number | null;
  desired_profit: number | null;
  frozen_market_data: MarketDataSnapshot;
  frozen_news_data: NewsDataSnapshot;
  frozen_macro_data: MacroDataSnapshot;
  vision_metadata: VisionParserOutput;
  status: SessionStatus;
  agent_analyses: StoredAgent[];
  debate: DebateResult | null;
  final_decision: (ChiefJudgeOutput & { chief_judge_model?: string; provider_used?: string }) | null;
  /** What the LLM governor saw during this run (rate limits, breaker, budget). */
  provider_diagnostics?: ProviderDiagnostics | null;
  position_sizing: {
    positionSizeLots: number | null;
    slDistancePips: number;
    warning?: string;
  } | null;
  outcome: (TradeOutcome & { recorded_at: string }) | null;
  error?: string;
}

export interface SessionIndexItem {
  id: string;
  created_at: string;
  user_symbol: string;
  user_timeframe: string;
  detected_symbol: string;
  status: SessionStatus;
  final_decision: string | null;
  screenshot_hash: string;
}

async function ensureDirs() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
}

async function readIndex(): Promise<SessionIndexItem[]> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf8');
    return JSON.parse(raw) as SessionIndexItem[];
  } catch {
    return [];
  }
}

async function writeIndex(items: SessionIndexItem[]) {
  await ensureDirs();
  await fs.writeFile(INDEX_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function sessionPath(id: string) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export async function saveScreenshot(hash: string, buffer: Buffer, ext = 'png'): Promise<string> {
  await ensureDirs();
  const filename = `${hash}.${ext}`;
  const full = path.join(SCREENSHOTS_DIR, filename);
  try {
    await fs.access(full);
  } catch {
    await fs.writeFile(full, buffer);
  }
  return `/api/screenshots/${filename}`;
}

export function screenshotDiskPath(filename: string): string {
  const safe = path.basename(filename);
  return path.join(SCREENSHOTS_DIR, safe);
}

export async function upsertSession(record: AnalysisSessionRecord): Promise<void> {
  await ensureDirs();
  await fs.writeFile(sessionPath(record.id), JSON.stringify(record, null, 2), 'utf8');
  const index = await readIndex();
  const item: SessionIndexItem = {
    id: record.id,
    created_at: record.created_at,
    user_symbol: record.user_symbol,
    user_timeframe: record.user_timeframe,
    detected_symbol: record.detected_symbol,
    status: record.status,
    final_decision: record.final_decision?.final_decision ?? null,
    screenshot_hash: record.screenshot_hash
  };
  const next = [item, ...index.filter((s) => s.id !== record.id)];
  await writeIndex(next);
}

export async function getSession(id: string): Promise<AnalysisSessionRecord | null> {
  try {
    const raw = await fs.readFile(sessionPath(id), 'utf8');
    return JSON.parse(raw) as AnalysisSessionRecord;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SessionIndexItem[]> {
  return readIndex();
}

export async function findCompletedByHash(hash: string): Promise<AnalysisSessionRecord | null> {
  const index = await readIndex();
  const match = index.find((s) => s.screenshot_hash === hash && s.status === 'COMPLETED');
  if (!match) return null;
  return getSession(match.id);
}

export async function recordOutcome(sessionId: string, outcome: TradeOutcome): Promise<AnalysisSessionRecord | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  session.outcome = { ...outcome, recorded_at: new Date().toISOString() };
  await upsertSession(session);
  return session;
}

export interface HealthLog {
  id: string;
  provider_name: string;
  endpoint_tested: string;
  status: 'PASS' | 'FAIL';
  latency_ms: number;
  error_message?: string;
  tested_at: string;
}

export async function appendHealthLog(log: Omit<HealthLog, 'id' | 'tested_at'>): Promise<HealthLog> {
  await ensureDirs();
  const entry: HealthLog = {
    ...log,
    id: crypto.randomUUID(),
    tested_at: new Date().toISOString()
  };
  let existing: HealthLog[] = [];
  try {
    existing = JSON.parse(await fs.readFile(HEALTH_FILE, 'utf8')) as HealthLog[];
  } catch {
    existing = [];
  }
  existing.unshift(entry);
  await fs.writeFile(HEALTH_FILE, JSON.stringify(existing.slice(0, 200), null, 2), 'utf8');
  return entry;
}

export async function listHealthLogs(): Promise<HealthLog[]> {
  try {
    return JSON.parse(await fs.readFile(HEALTH_FILE, 'utf8')) as HealthLog[];
  } catch {
    return [];
  }
}
