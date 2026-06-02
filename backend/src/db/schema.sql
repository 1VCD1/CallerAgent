-- AI Phone Agent Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";  -- pgvector for embeddings

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  firebase_uid TEXT UNIQUE,
  email TEXT UNIQUE,
  name TEXT,
  phone_number TEXT,
  birthday DATE,
  language TEXT DEFAULT 'en',
  push_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add firebase_uid to existing deployments that predate this column
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT UNIQUE;

-- Calls
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  company TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  user_phone_number TEXT,
  goal TEXT NOT NULL DEFAULT 'reach_human',
  status TEXT NOT NULL DEFAULT 'INIT',
  twilio_call_sid TEXT,
  user_call_sid TEXT,
  conference_sid TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  ended_reason TEXT,
  human_reached BOOLEAN DEFAULT FALSE,
  human_confidence FLOAT,
  wait_duration_seconds INTEGER,
  recording_sid TEXT,
  recording_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_company ON calls(company);

-- Call Events (timeline of everything that happened)
CREATE TABLE IF NOT EXISTS call_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_call_events_call_id ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_call_events_timestamp ON call_events(timestamp);

-- Transcripts
CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL CHECK (speaker IN ('AI', 'IVR', 'HUMAN')),
  text TEXT NOT NULL,
  human_confidence FLOAT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcripts_call_id ON transcripts(call_id);

-- Action History
CREATE TABLE IF NOT EXISTS action_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  value TEXT,
  reasoning TEXT,
  success BOOLEAN DEFAULT TRUE,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_history_call_id ON action_history(call_id);

-- User notes per company (user-written tips that feed back into the LLM context)
CREATE TABLE IF NOT EXISTS user_company_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company)
);

CREATE INDEX IF NOT EXISTS idx_user_company_notes_user ON user_company_notes(user_id);

-- Company IVR Notes (post-call LLM summaries for future calls to same company)
CREATE TABLE IF NOT EXISTS company_ivr_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company TEXT NOT NULL,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ivr_notes_company ON company_ivr_notes(company);
ALTER TABLE company_ivr_notes ADD COLUMN IF NOT EXISTS phone_number TEXT;
CREATE INDEX IF NOT EXISTS idx_ivr_notes_phone ON company_ivr_notes(phone_number);
ALTER TABLE user_company_notes ADD COLUMN IF NOT EXISTS phone_number TEXT;
CREATE INDEX IF NOT EXISTS idx_user_notes_phone ON user_company_notes(phone_number);

-- ── Evaluation / Test Framework ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS test_scenarios (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT 'reach_human',
  ivr_persona TEXT NOT NULL,        -- system prompt describing how this IVR behaves
  expected_outcome TEXT NOT NULL,   -- 'human_reached' | 'outside_hours' | 'no_human_path' | etc.
  has_human BOOLEAN NOT NULL DEFAULT false,  -- does this scenario end with a real human?
  max_turns INTEGER NOT NULL DEFAULT 20,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  triggered_by TEXT DEFAULT 'manual',
  total_scenarios INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  accuracy FLOAT,                   -- passed / total
  human_detection_rate FLOAT,       -- % of has_human scenarios where human was escalated
  false_positive_rate FLOAT,        -- % of no-human scenarios that incorrectly escalated
  avg_turns FLOAT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS test_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  scenario_id UUID NOT NULL REFERENCES test_scenarios(id) ON DELETE CASCADE,
  passed BOOLEAN NOT NULL,
  actual_outcome TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  turns INTEGER NOT NULL,
  human_detected BOOLEAN NOT NULL DEFAULT false,
  false_positive BOOLEAN NOT NULL DEFAULT false,
  transcript JSONB NOT NULL DEFAULT '[]',   -- [{role:'IVR'|'AI', text, turn}]
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_results_run ON test_results(run_id);
CREATE INDEX IF NOT EXISTS idx_test_results_scenario ON test_results(scenario_id);

-- Adaptive Memory Patterns (THE CORE PRODUCT ASSET)
CREATE TABLE IF NOT EXISTS memory_patterns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT 'reach_human',
  path JSONB NOT NULL DEFAULT '[]',          -- array of action steps
  success_rate FLOAT NOT NULL DEFAULT 0.0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  avg_wait_seconds INTEGER,
  last_verified_at TIMESTAMPTZ DEFAULT NOW(),
  strategy_embedding vector(1536),           -- semantic similarity search
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_patterns_company ON memory_patterns(company);
CREATE INDEX IF NOT EXISTS idx_memory_patterns_goal ON memory_patterns(goal);
CREATE INDEX IF NOT EXISTS idx_memory_patterns_success_rate ON memory_patterns(success_rate DESC);
CREATE INDEX IF NOT EXISTS idx_memory_patterns_embedding ON memory_patterns USING hnsw (strategy_embedding vector_cosine_ops);

-- Phone-number-keyed memory (added to fix company-name collision between different IVR trees)
ALTER TABLE memory_patterns ADD COLUMN IF NOT EXISTS phone_number TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_patterns_phone ON memory_patterns(phone_number);

ALTER TABLE ivr_decision_nodes ADD COLUMN IF NOT EXISTS phone_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ivr_nodes_phone_unique
  ON ivr_decision_nodes(phone_number, ivr_text, ai_action, ai_value);
