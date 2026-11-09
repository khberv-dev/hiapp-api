# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

`hiapp-api` is a NestJS 12 voice-conversation server: the client streams mic audio over a WebSocket and gets the AI's reply back as voice. The README is the stock Nest starter and has no project-specific information.

Pipeline per user utterance, all via Google Gemini (`@google/genai`):

```
binary PCM16 16k ─► STT (Live API) ─► final transcript ─► LLM stream ─► SentenceSplitter ─► TTS per sentence ─► binary PCM16 24k
```

- **Backend switch** (`genai.provider.ts`, `genAiOptions`): `GENAI_BACKEND=gemini` (default) uses the Gemini Developer API with `GEMINI_API_KEY`. `GENAI_BACKEND=vertex` uses Vertex AI with a service-account JSON key read from `GOOGLE_CREDENTIALS_FILE` (default `google-service-account.json`, relative to the project root, gitignored; the role needed is `roles/aiplatform.user`). The project defaults to the key's `project_id` (`GOOGLE_CLOUD_PROJECT` overrides it), the location to `global` (`GOOGLE_CLOUD_LOCATION`). A missing or invalid key fails at startup. Both backends share every adapter; model IDs, region availability and error shapes (e.g. 429s without retry hints) can differ, so check the model env vars when switching.
- `src/modules/ai/`: provider-agnostic ports in `ai.types.ts` (`SttPort`, `LlmPort`, `TtsPort`), injected via the `STT`/`LLM`/`TTS` tokens and assembled in `ai.module.ts` factories. Orchestration code must depend only on the ports so tests can use fakes. **All resilience lives in this layer**, as composites/decorators around single-model adapters (`GeminiStt`, `GeminiLlm`, `GeminiTts`):
  - `provider-error.ts`: every adapter throws a `ProviderError` with a `kind` (`overloaded`, `rate_limited`, `timeout`, `network`, `auth`, `bad_request`, `unknown`) via `classifyGeminiError`. `auth`/`bad_request` are never retried. `retryAfterMs` comes from the `retry-after` header, a `RetryInfo` detail, or "retry in 2h9m16s" in the message. A real TTS 429 has the header and the text but no `RetryInfo`.
  - `fallback.ts` (`fallbackStream`): the shared chain. Each attempt has a first-event deadline (`firstEventDeadline` in `retry.ts`). Before the first item it retries or moves to the next entry; after the first item an error is rethrown, because the user already got part of it. Each entry has a `CircuitBreaker`: 5 retryable failures in 30 s, or a server retry hint of 20 s or more, opens it. An open entry is skipped until a half-open trial. If every entry is open, all are tried anyway.
  - LLM (`FallbackLlm`, chain `LLM_MODELS`): `models.generateContentStream`. A missed first-token deadline (`LLM_FIRST_TOKEN_MS`) or a 429 moves to the next model at once. `overloaded`/`network` get one jittered retry first.
  - TTS (`FallbackTts`, chain `TTS_MODELS`): `ai.interactions.create({ stream: true, response_format: { type: 'audio', mime_type: 'audio/l16' } })`, reading `step.delta` audio events. This is the current Gemini streaming-TTS API, not `generateContentStream`.
    - On Vertex AI (`ai.vertexai`), the Interactions API rejects TTS models ("not supported by the Interactions API"), so `GeminiTts` uses `models.generateContentStream` with `responseModalities: AUDIO` instead. It streams `audio/l16; rate=24000` parts (verified live with `gemini-3.8-flash-tts`, ~0.8 s to first chunk warm, ~1.8 s cold). A part at another rate is a `bad_request`. `gemini-3.5-flash-tts` does not exist on Vertex (404).
    - The Interactions client retries 429/5xx internally (up to 4 times, 30 s), so `GeminiTts` passes `maxRetries: 0`.
    - `FallbackTts` retries `TTS_RETRIES` times per model, with a `TTS_FIRST_CHUNK_MS` deadline per attempt. A 429 whose hint exceeds 1.5 s isn't retried.
    - All entries must share one `sampleRate`, checked in the constructor. A different-rate provider must resample in its adapter.
  - STT (`ResilientStt` wrapping `GeminiStt`): `ai.live.connect` with `inputAudioTranscription` (pinned by `STT_LANGUAGES`, default `en-US`) and `automaticActivityDetection` (`STT_SILENCE_MS`, high end-of-speech sensitivity). Interim text arrives as `serverContent.interimInputTranscription`, final text as `inputTranscription`.
    - The SDK's `connect()` never settles if the server closes before setup (e.g. bad API key), so `GeminiStt` races it against close/timeout itself.
    - `GeminiStt` reports `goAway` through `onGoAway` and doesn't reconnect.
    - `ResilientStt` handles `goAway` make-before-break: it opens a new connection, switches audio to it, calls `endOfAudio()` on the old one, and still accepts that one's final for `drainMs`.
    - On a drop it reconnects with full-jitter backoff for up to `STT_RECONNECT_BUDGET_MS`, reporting `onStatus('reconnecting'|'ok')`. It then replays the audio received since the last final, at most `STT_REPLAY_BUFFER_MS`.
    - `onUnexpectedClose` reaches the session only when the budget is spent, after too many connections in a row die within 5 s, or on an `auth` error (immediately).
    - `audioStreamEnd` (`end_of_audio`) does *not* end the Live stream: later audio still gets transcribed. This was verified live.
  - `fault-injection.ts`: `AI_FAULT_RATE` (testing only) wraps every port with random injected 503s and STT drops.
- `src/modules/conversation/`: `ConversationGateway` (raw `ws` via `WsAdapter`, path `/v1/conversation`) authenticates the connection, records (or resumes) a `Conversation` row, then creates one `ConversationSession` per connection. The session is a plain class, not a Nest provider, and owns the whole turn lifecycle:
  - It opens STT once. Reconnecting is the port's job: the session relays `status` messages, and when the port gives up it aborts the turn and closes with 1011.
  - Each turn has its own `AbortController`. A new final transcript or an `interrupt` message aborts the turn (barge-in), sends `tts_stop`, and keeps only the fully spoken sentences in history.
  - TTS for each sentence starts as soon as the splitter emits it (`prefetch`), but audio is sent strictly in order through a promise chain. A sentence that still fails after the TTS retries is **skipped**. The turn fails (`error`) only if no sentence produced audio; otherwise it gets `tts_end` and the full LLM text is kept in history.
  - `SentenceSplitter({ minChars: 20, firstChunkMaxChars: 60 })`: if the first chunk has no sentence end within 60 chars, it is cut at the last clause boundary (`, ; : —`), so the first TTS request starts sooner. Later chunks are whole sentences.
  - **Turn timing**: `TurnTimer` logs one JSON line per turn (`{"evt":"turn",...}`), with no transcript text. It has the marks `final` (t=0), `llmFirstToken`, `firstSentence`, `ttsFirstChunk`, `firstAudioSent`, `llmDone` and one of `ttsEnd`/`aborted`/`failed`, plus `finalLagMs` (final vs. the client's `end_of_audio`, or the last interim) and `served.{llm,tts}` (the provider entry that answered). `SEND_TURN_METRICS=true` also sends it to the client as `turn_metrics`.
- The wire protocol is documented at the top of `src/modules/conversation/protocol.ts`. `TOKEN=<accessToken> node scripts/test-client.mjs <file.pcm>` streams a 16 kHz PCM file and writes the reply to `out.pcm`.
- **WebSocket auth**: the access token from `/auth/google` must be sent in an `Authorization: Bearer` header. `?token=` is not accepted, because query strings end up in proxy and access logs. The gateway verifies it with `JwtService` and checks that the user still exists; otherwise it closes with 4401 (`CloseCode` in `protocol.ts`). Auth happens in `handleConnection`, so frames the client sends before `ready` are dropped.
- **Conversation records**: `Conversation` (table `conversations`): `userId` (FK → `users`, `ON DELETE CASCADE`), `startedAt` set when the connection is accepted, `endedAt` set on disconnect. `ConversationService.end` is idempotent (`WHERE ended_at IS NULL`). `beforeApplicationShutdown` ends conversations still open at shutdown, so only a crash leaves `endedAt` null. A connection whose STT fails to start is still recorded, with near-equal start and end.
- **Transcripts**: `Turn` (table `turns`): `conversationId` (FK, cascade), `role` (Postgres enum `user` | `ai`, `TurnRole` in code), `text`. Order turns by `createdAt`. The session reports turns through the `onTurn` option: each final STT transcript is a `user` turn. Each AI reply is an `ai` turn once fully spoken; on barge-in or disconnect, only the fully spoken sentences are saved, and nothing if none were. The gateway chains each connection's inserts on one promise, so they land in order and are flushed before `endedAt` is written.
- **Daily limit**: conversation time per user per calendar day in `USAGE_TIMEZONE` (IANA name, default `UTC`).
  - The limit is the current subscription's `plan.dailyLimitSeconds`, or `DAILY_LIMIT_SECONDS` (free tier) if the user has none, and never below the free tier. "Current" means paid with `startDate <= now < endDate` (`SubscriptionService.findCurrentByUser`); a stacked renewal that starts later doesn't count yet.
  - The limit is read once at connect. Subscribing mid-conversation applies on the next connection; a subscription expiring mid-conversation doesn't shorten it.
  - Before accepting a connection, the gateway computes `usedSecondsToday` (one SQL query in `ConversationService`). If nothing is left, it sends `limit_reached` and closes 4403. Otherwise it reports `remainingSec` in `ready` and arms a `setTimeout` that sends `limit_reached` and closes 4403 when the remaining time runs out. `release()` (disconnect, replacement, shutdown) clears the timer.
  - Usage = sum of conversation durations clipped to today, so a conversation crossing midnight counts only from midnight. An open conversation counts up to `min(now, updatedAt + HEARTBEAT_SECONDS)`. Live connections bump `updatedAt` every 30 s (`touch`), so one orphaned by a crash stops counting about 30 s after its last heartbeat instead of growing forever.
  - One live connection per user (per server instance): a new connection closes the previous one with 4409 and ends its conversation *before* usage is computed. Otherwise parallel sockets could each spend the full remaining allowance.
  - The timer is armed with the day's remaining time, so a conversation that crosses midnight is still cut at that allowance.
- **Resume**: `?resume=<conversationId>` (the id comes from `ready`). It is accepted only if the conversation is the user's and still open or ended less than `RESUME_WINDOW_SEC` (default 120) ago (`ConversationService.findResumable`).
  - When accepted, the row is reopened (`endedAt = null`), its last 20 turns are loaded as LLM history, and `ready` has `resumed: true`.
  - Otherwise a new conversation starts. A bad id never fails the connect.
  - The gateway first waits for a still-running `release()` of that conversation, so its `end()` can't land after the reopen.
  - The gap between disconnect and resume counts as used time, because usage is measured from the row's `startedAt`.
- **Liveness**: the gateway pings every `WS_PING_MS` (15 s) and terminates a peer that missed the previous pong. Without this, a dead phone would hold a Live session and spend its allowance until TCP times out. A client whose `bufferedAmount` exceeds 1 MB (~20 s of audio, i.e. it isn't reading) is terminated. `ws` message handlers are wrapped in try/catch, since an exception there would crash every session in the process.
- **Multiple instances**: one-connection-per-user, the resume wait and the circuit breakers are in-memory, per process. Running more than one instance needs a shared lock (Redis or a Postgres advisory lock) for the per-user rule.
- The only other rate limit is the one on `POST /auth/login`.

## Users and auth

- `User` (`src/modules/user/`, table `users`): `firstName` (required), `lastName` and `email` (nullable), `googleId` (nullable, unique), `createdAt`/`updatedAt`, `password` (nullable).
- **Password**: stored as a scrypt hash (`scrypt$<salt>$<hash>`, `password.ts`: `hashPassword`/`verifyPassword`), never in plain text. The column is `select: false`, so it's never loaded or returned unless a query adds it explicitly. `PUT /user/password` `{ password }` (8–128 chars, `JwtAuthGuard`) sets or replaces it without the old password and returns 204, or 404 if the user no longer exists. `email` is stored lowercased (`normalizeEmail`) and only if Google marks it verified. It has a unique index (`UQ_users_email`, nulls allowed). If a Google sign-in brings an email another user already has, that account is saved without an email instead of failing.
- `GET /user/me` (`JwtAuthGuard`) → 200 `{ id, firstName, lastName, email, hasPassword }`, or 404 if the user was deleted (the guard checks only the token). The profile part is `toUserResponse` (`user-response.ts`), shared with the sign-in response; `hasPassword` is computed from the `select: false` column, which is never returned.
- `POST /auth/login` `{ email, password }` → 200 `{ accessToken, user }` (same as Google sign-in), for an existing user who set a password. Every bad-credential case (unknown email, no password, wrong password) is the same 401 `Invalid email or password`, and an unknown email still runs scrypt against a dummy hash so timing doesn't reveal accounts.
  - **Rate limit** (`LoginRateLimiter`, in memory, per process): `AUTH_LOGIN_MAX_PER_EMAIL` (5) attempts per email and `AUTH_LOGIN_MAX_PER_IP` (20) per IP per `AUTH_LOGIN_WINDOW_SEC` (900) fixed window. Attempts count when they start, so parallel requests can't race past it; blocked attempts don't count; a success resets the email counter only. Over the limit → 429 `{ retryAfterSec }` with a `Retry-After` header. The email key counts whether or not the account exists.
  - The IP is Express's `req.ip`. Behind a reverse proxy, set `TRUST_PROXY` (e.g. `1`), or every client shares the proxy's IP budget.
- `POST /auth/google` `{ idToken }` → 200 `{ accessToken, user: { id, firstName, lastName, email } }`. Its counterpart for passwords is `POST /auth/login`.
  - `GoogleTokenVerifier` calls `https://oauth2.googleapis.com/tokeninfo?id_token=...`. Google checks the signature and expiry; we also require `iss` to be Google and `aud` to be one of `GOOGLE_CLIENT_IDS`. Without the `aud` check, a token issued to any other app would be accepted. Google's 4xx → 401; network errors and 5xx → 502.
  - `UserService.upsertFromGoogle` runs a single `INSERT ... ON CONFLICT (google_id) DO UPDATE`, so the profile is refreshed on every sign-in and concurrent first sign-ins can't create duplicates.
- Access tokens are HS256 JWTs signed with `JWT_SECRET`, payload `{ sub: userId }`, valid 365 days. There are no refresh tokens or revocation. `JwtModule` is registered globally in `AuthModule`, so `JwtService` can be injected anywhere.
- HTTP auth: protect a route with `@UseGuards(JwtAuthGuard)` and read the id with `@CurrentUserId()` (`src/common/guards/`, `src/common/decorators/`). `OptionalJwtAuthGuard` lets requests without a header through as anonymous (`null`). The guard checks only the token, not that the user still exists. Both are copied from `pointvpn-api`.
- Auth actions (sign-ins, Google requests and responses) are not logged on success. Only failures to reach Google are logged.

## Plans, subscriptions and payments (Multicard / RHMT)

Ported from `pointvpn-api`, but subscriptions belong to a **user** instead of a device session, and each plan defines its own duration.

- `Plan` (`plans`): `name`, `price` in **UZS** (`numeric(12,2)`; `numberTransformer` turns Postgres's string into a `number`), `durationDays`, `dailyLimitSeconds` (speaking time per day while subscribed; the DB default of 3600 only exists so `synchronize` can add the column to existing rows). Public `GET /plans`, sorted by price. There is no create/update API: insert plans directly.
- `Subscription` (`subscriptions`): `userId` (cascade), `planId` (`RESTRICT`, so a plan with subscriptions can't be deleted), `isActive` (default false), `startDate`/`endDate` (nullable, set on payment).
- Authenticated routes (`JwtAuthGuard`):
  - `GET /subscriptions` returns the user's paid, not-yet-ended subscriptions, ordered by `startDate`, each with its `plan`.
  - `POST /subscriptions` `{ planId }` creates an inactive subscription, an `Invoice` row, then the Multicard invoice. It returns 201 `{ subscriptionId, invoiceId, amount, checkoutUrl }`; the app opens `checkoutUrl`.
- `POST /payment/handle` (`PaymentController`, = `RHMT_CALLBACK_URL`) is Multicard's callback after a successful payment. It marks the invoice paid and activates the subscription for `plan.durationDays`.
  - **Renewals stack**: if the user still has paid time, the new period starts at the latest active `endDate`, otherwise now. The user row is locked (`FOR UPDATE`) during activation, so two payments landing at once can't both start at the same moment.
- `amount` is in tiyin: `Math.round(plan.price × 100)`. `invoice_id` sent to Multicard is our `Invoice.id` (uuid).
- `RhmtService` (`src/modules/rhmt/`, copied unchanged): `POST {RHMT_API_URL}/auth` with `{ application_id, secret }` returns a JWT valid ~24h (`expiry` is GMT+5). The token is cached in memory, concurrent callers share one auth request, and a 401 triggers one re-auth and retry. `POST /payment/invoice` sends `{ store_id, amount, invoice_id, callback_url }`. Multicard can return errors with HTTP 200 and `success: false`; failures become 502 and the invoice is marked `failed`.
- **Callback contract**: always respond HTTP 200 with `{ success, message? }`. `success: false` or a non-200 makes Multicard **cancel and refund** the payment; a 500 or timeout makes it retry. Checks, in order: payload shape, `sign = md5(store_id + invoice_id + amount + RHMT_SECRET)` (case-insensitive, timing-safe), store id, invoice exists, amount matches. Processing runs in a transaction with a row lock on the invoice. A repeat callback with the same `uuid` on a paid invoice returns success (idempotent); a different `uuid` is rejected (refunded). The body is typed as an interface so the global `ValidationPipe` doesn't strip Multicard's extra fields; the service validates it by hand.
- A current subscription raises the conversation daily limit to its plan's `dailyLimitSeconds` (see Daily limit above).
- `main.ts` installs a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`): request DTOs are class-validator classes, and unknown body fields get a 400.

## Layout

The structure mirrors the sibling project `pointvpn-api`:

- `src/common/`: cross-cutting Nest building blocks (`decorators/`, `guards/`, `pipes/`).
- Module, service and controller names are **singular** (`user/`, `UserService`, `plan/`, `PlanService`); table names are plural (`users`, `plans`).
- `src/modules/`: feature modules, each with its own `*.module.ts` (and `entities/` once it has tables). Register new modules in `AppModule.imports`.
- `src/shared/entities/`: column transformers (`numberTransformer` for `numeric`/`bigint`).
- `public/`: static files served at the root by `useStaticAssets` in `main.ts` (`.html` optional in the URL, e.g. `/privacy_policy`). It's resolved relative to `dist/`, so it must stay at the project root and be deployed alongside `dist/`.
- `src/shared/config/`: configuration. `database.config.ts` builds the TypeORM `DataSourceOptions` from env and creates the `DataSource`; `AppModule` feeds both into `TypeOrmModule.forRootAsync` (`useFactory` + `dataSourceFactory`).

## Database

PostgreSQL via TypeORM 1.x (`pg` driver).

- **Naming**: camelCase in code, snake_case in the DB, handled globally by `SnakeNamingStrategy` (`src/shared/config/snake-naming.strategy.ts`). Don't add `name:` options to columns just to get snake_case. Table names default to the snake_cased class name; give a plural name explicitly, e.g. `@Entity('users')`.
- **Schema**: `synchronize: true`, no migrations. The schema follows the entities on startup, so renaming or removing a property drops that column's data.
- **Entities** are registered via `autoLoadEntities`: an entity exists only if some module lists it in `TypeOrmModule.forFeature([...])`.
- **Every entity must have `createdAt` and `updatedAt`, declared by hand as its last two properties:**
  ```ts
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
  ```
- **Entities never inherit from other classes**: no base entity, no `extends`. Every column is declared in the entity itself.
- `updated_at` is bumped by `save()` and `repository.update()`. Raw `upsert()` doesn't bump it reliably, so pass `updatedAt: new Date()` explicitly, as `UserService.upsertFromGoogle` does.
- Relations follow the `pointvpn-api` style: an explicit FK column (`@Column('uuid') userId`) next to the `@ManyToOne(() => User, { onDelete: ... })` property, so you can filter by id without a join.

## Commands

```bash
npm install
npm run start:dev          # watch mode (nest start --watch)
npm run start:debug        # watch + inspector
npm run build              # nest build -> dist/ (output dir wiped each build)
npm run start:prod         # node dist/main

npm run lint               # oxlint --type-aware src/ test/
npm run format             # prettier on src/ and test/

npm test                   # vitest run, unit tests (**/*.spec.ts)
npm run test:e2e           # vitest, e2e tests (**/*.e2e-spec.ts)
npm run test:cov           # coverage via @vitest/coverage-v8
npx vitest run path/to/file.spec.ts        # single test file
npx vitest run -t "test name pattern"      # single test by name
```

## Runtime configuration

- `PORT`, `GEMINI_API_KEY` (only with `GENAI_BACKEND=gemini`; with `vertex`, the key file instead), `JWT_SECRET`, `GOOGLE_CLIENT_IDS` (comma-separated), `DAILY_LIMIT_SECONDS`, `RHMT_API_URL`, `RHMT_APPLICATION_ID`, `RHMT_SECRET`, `RHMT_STORE_ID`, `RHMT_CALLBACK_URL` and `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` are required and read with `getOrThrow`, so the app won't start without them (see `.env.example` for the optional overrides: models and chains, deadlines, retries, STT language/silence/reconnect budget, `WS_PING_MS`, `RESUME_WINDOW_SEC`, `SEND_TURN_METRICS`, and `AI_FAULT_RATE` for testing only). `ConfigModule.forRoot({ isGlobal: true })` reads `.env` from the project root (gitignored), so `ConfigService` can be injected anywhere without importing `ConfigModule`.

## Toolchain conventions that differ from a typical Nest project

- **ESM, not CommonJS.** `package.json` has `"type": "module"` and tsconfig uses `module`/`moduleResolution: nodenext`. Relative imports **must** include the `.js` extension (e.g. `import { AppModule } from './app.module.js'`). Top-level `await` is used in `main.ts`.
- **Vitest instead of Jest.** Globals (`describe`, `it`, `expect`, `vi`) come from `vitest/globals`. Use `vi.fn()`/`vi.mock()`, not `jest.*`. `vite-tsconfig-paths` resolves tsconfig path aliases (including ones added by `nest g library`).
- **oxlint instead of ESLint.** `.oxlintrc.json` turns on `typescript/no-floating-promises` as an error, so every promise must be awaited or handled. `no-explicit-any` is off.
- **Prettier:** single quotes, trailing commas everywhere.
- **TypeScript:** `strict` is on but `strictPropertyInitialization` is off, so DI-injected and DTO properties don't need initializers. Decorator metadata is enabled for Nest DI.
- `tsconfig.build.json` excludes `test/` and `*spec.ts` from the build.
