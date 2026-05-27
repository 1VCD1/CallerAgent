# CallerAgent — AI Phone Agent

CallerAgent is an AI-powered phone agent that calls customer service numbers on your behalf. It autonomously navigates IVR (Interactive Voice Response) menus, waits on hold, detects when a live human picks up, and then bridges you into the call — so you only join when a real person is on the line.

---

## How It Works

1. You submit a call request (company name, phone number, your goal)
2. The agent dials the number via Twilio
3. Claude listens to the IVR transcript in real time and decides what to do — press a key, say a phrase, or wait
4. Deepgram transcribes the audio; a human detector watches for a live agent
5. Once a human is detected, you receive a push notification and get bridged into the call via conference

```
INIT → DIALING → IVR_NAVIGATION → EXPLORATION → ON_HOLD → HUMAN_DETECTED → USER_NOTIFIED → BRIDGED → ENDED
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + TypeScript + Fastify |
| Database | PostgreSQL + pgvector |
| Queue | Redis + BullMQ |
| Telephony | Twilio Voice (outbound calls, DTMF, conference bridge) |
| Speech-to-Text | Deepgram (nova-2-phonecall, 8kHz mulaw) |
| LLM | Claude (Anthropic SDK) |
| Mobile | Expo + React Native |

---

## Project Structure

```
CallerAgent/
├── backend/
│   ├── src/
│   │   ├── api/
│   │   │   └── routes/
│   │   │       ├── calls.ts        # REST API — users, calls, bridge, SSE events
│   │   │       └── webhooks.ts     # Twilio webhook handlers
│   │   ├── config/
│   │   │   └── index.ts            # Environment config
│   │   ├── db/
│   │   │   ├── client.ts           # PostgreSQL client
│   │   │   ├── migrate.ts          # Migration runner
│   │   │   └── schema.sql          # DB schema
│   │   ├── queue/
│   │   │   └── call-processor.ts   # BullMQ job processor
│   │   ├── services/
│   │   │   ├── audio-analyzer.ts   # Audio stream analysis
│   │   │   ├── call-orchestrator.ts # Core orchestration loop
│   │   │   ├── call-summarizer.ts  # Post-call LLM summary
│   │   │   ├── human-detector.ts   # Keyword + cadence heuristic
│   │   │   ├── llm-engine.ts       # Claude decision engine
│   │   │   ├── memory.ts           # IVR pattern memory (pgvector)
│   │   │   ├── notifications.ts    # Expo push notifications
│   │   │   ├── telephony.ts        # Twilio client + DTMF
│   │   │   └── transcription.ts    # Deepgram realtime STT
│   │   ├── state-machine/
│   │   │   └── CallStateMachine.ts # Call state transitions
│   │   ├── types/
│   │   │   └── index.ts            # Shared TypeScript types
│   │   └── index.ts                # Server entry point + WebSocket setup
│   ├── public/
│   │   ├── index.html              # Landing page
│   │   └── monitor.html            # Live call audio monitor (browser)
│   ├── .env.example                # Required environment variables
│   ├── package.json
│   └── tsconfig.json
├── mobile/                         # Expo React Native app
│   ├── app/
│   │   ├── (tabs)/
│   │   │   ├── index.tsx           # Start a call
│   │   │   ├── history.tsx         # Call history
│   │   │   └── profile.tsx         # User profile
│   │   └── call/[id].tsx           # Live call status screen
│   └── src/
│       ├── api.ts                  # Backend API client
│       └── theme.ts                # UI theme
├── docker-compose.yml              # PostgreSQL + Redis
└── idea.md                         # Original product spec
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/users` | Create a user profile |
| `GET` | `/users/:id` | Get user profile |
| `PATCH` | `/users/:id` | Update profile / push token |
| `POST` | `/calls` | Start a new AI call |
| `GET` | `/calls/:id` | Get call status |
| `POST` | `/calls/:id/bridge` | Bridge user into an active call |
| `GET` | `/calls/:id/events` | SSE stream of call events |
| `WS` | `/ws/audio/:callId` | Twilio audio stream ingestion |
| `WS` | `/ws/monitor/:callId` | Live audio feed for browser monitor |
| `GET` | `/monitor/active` | Redirect to monitor for current call |
| `GET` | `/health` | Health check |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Docker (for PostgreSQL and Redis)
- Twilio account with a phone number and TwiML app
- Deepgram API key
- Anthropic API key
- (Optional) ngrok or cloudflared for local webhook tunneling

### 1. Start the database and cache

```bash
docker-compose up -d
```

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
# Fill in your API keys and credentials
```

### 3. Run migrations

```bash
cd backend
npm install
npm run db:migrate
```

### 4. Start the backend

```bash
npm run dev
```

The server starts on `http://localhost:3000`.  
Open `http://localhost:3000/monitor/active` to watch live call audio in the browser.

### 5. (Optional) Start the mobile app

```bash
cd mobile
npm install
npx expo start
```

---

## Environment Variables

See [`backend/.env.example`](backend/.env.example) for the full list. Key variables:

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Your Twilio outbound number |
| `DEEPGRAM_API_KEY` | Deepgram API key |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) API key |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `APP_BASE_URL` | Public URL for Twilio webhooks (use ngrok locally) |

---

## IVR Language Support

The agent supports multilingual IVR navigation:

- `en` — English
- `zh-TW` — Traditional Chinese
- `zh-CN` — Simplified Chinese

Pass `ivrLanguage` in the call request to match the target IVR's language.
