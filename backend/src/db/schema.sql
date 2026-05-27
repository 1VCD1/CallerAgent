-- AI Phone Agent Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";  -- pgvector for embeddings

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE,
  name TEXT,
  phone_number TEXT,
  birthday DATE,
  language TEXT DEFAULT 'en',
  push_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
