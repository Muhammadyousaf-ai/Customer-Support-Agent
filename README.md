# Support AI

A customer-support agent with **streaming chat**, **live voice (Gemini Live)**, **RAG-grounded answers with confidence guardrails**, **autonomous multi-step tools** (simulated business actions), **persistent shared memory** and an **observability drawer** (prompt traces, latency, tokens, estimated cost).

> **Status, stated plainly.** Everything below is implemented and tested locally. **It is not deployed**: no hosting accounts were available to the author of this repository snapshot, so there is no public URL, no production smoke test and no walkthrough video yet (`docs/deployment.md` is the runbook). A real-model evaluation could not be completed because the available Gemini key is on the free tier (20 requests/day/model). See `docs/known-limitations.md` and `docs/evaluation-results.md` before relying on any claim.

## What it does
- **Agent:** LangGraph.js graph (initialize → context → model decision → validate → execute → evaluate → verify → finalize/escalate/recover). The model proposes; the backend authorizes. Confirmation for sensitive actions is backend-validated and action-bound; refunds are idempotent and committed in one transaction.
- **RAG:** custom chunking, pgvector retrieval, confidence thresholds, evidence verification; unsupported questions escalate to a ticket instead of being answered.
- **Chat:** REST + SSE (fetch-based, resumable with `Last-Event-ID`), live tool indicators, confirmation/refund/escalation cards from backend payloads only.
- **Voice:** browser AudioWorklet (16 kHz PCM) → NestJS WebSocket → Gemini Live. Gemini can call exactly one function that delegates to the same agent; native audio is gated until a verified answer exists and is checked against it; barge-in clears playback by audio generation; sessions resume/recover; everything falls back to chat.
- **Observability:** OpenTelemetry spans persisted to PostgreSQL, every model call recorded (sanitized) with usage and a versioned-price cost estimate, retrieval/guardrail/tool inspectors, voice diagnostics.
- **Production hardening (Phase 8):** Helmet, body-size limits, CORS allow-list, per-conversation and per-IP rate limits, a **daily AI budget with reservations**, liveness/readiness/dependency endpoints, graceful drain on SIGTERM, startup refusal of unsafe production config, Docker image, CI.

## Architecture
```
 Browser (Next.js) ──REST/SSE──▶ ┌────────────── NestJS API (modular monolith) ──────────────┐
   chat · voice · drawer         │ sessions/auth · rate limits · budget · health · lifecycle  │
 Browser ──WebSocket (PCM)─────▶ │ voice gateway ─▶ Gemini Live adapter ─▶ Gemini Live API   │
                                 │        └─ resolve_support_request ─┐                        │
                                 │ agent (LangGraph) ◀────────────────┘  ◀─ chat controller   │
                                 │   ├─ ToolExecutor ─▶ services (customers, refunds, …)      │
                                 │   ├─ RAG ─▶ pgvector                                       │
                                 │   └─ LLM provider (Gemini, instrumented)                   │
                                 │ observability: spans · invocations · pricing · writer      │
                                 └──────────────────────── PostgreSQL + pgvector ─────────────┘
```
Diagrams and the decision log: `docs/architecture.md`.

## Quick start (local)
```bash
cp .env.example .env            # add GEMINI_API_KEY (optional: AGENT_LLM=e2e runs a scripted model without any key)
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm --filter api rag:ingest
pnpm dev                        # web :3000, api :4000
```
Demo website login: `sarah@example.com`, password `demo-password-1`. Her support verification code is `482910` (fictional). Without a key: `AGENT_LLM=e2e VOICE_PROVIDER=fake pnpm dev`.

## Commands
| | |
|---|---|
| `pnpm lint` · `pnpm check-types` · `pnpm test` · `pnpm build` | static checks and the unit/integration suites (real PostgreSQL) |
| `pnpm --filter web exec playwright test -c playwright.voice.config.ts` | browser suites (chat regression, voice with a fake microphone, observability drawer) on ports 3100/4100 |
| `pnpm test:e2e` | the original chat browser suite on 3000/4000 |
| `pnpm --filter api agent:eval` | 41 real-model scenarios (needs a billed Gemini key) |
| `pnpm --filter api rag:eval -- --sweep` | retrieval/guardrail evaluation |
| `pnpm --filter api voice:smoke` | one real Gemini Live round trip |
| `node tests/performance/load.mjs --base=http://localhost:4400` | load test (start the API with `AGENT_LLM=e2e`) |

## Documentation
`docs/architecture.md` · `agent.md` · `rag.md` · `tools.md` · `chat.md` · `voice.md` · `observability.md` · `security.md` · `deployment.md` · `testing.md` · `evaluation-results.md` · `known-limitations.md` · `phase8-report.md`

## Design decisions (short)
Modular monolith (one deployable; WebSockets and SSE need a long-lived process). TypeScript throughout. Deterministic backend rules authorize every business action; the LLM only proposes. One shared agent for chat and voice. PostgreSQL for data, vectors, checkpoints and traces. A backend proxy for Gemini Live (key never reaches the browser) at the price of one extra network hop. Longer rationale in `docs/architecture.md`.
