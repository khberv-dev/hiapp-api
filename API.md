# hiapp-api — API reference

A voice-conversation backend for English-speaking practice. The app signs a user in, streams microphone audio over a WebSocket, and gets the AI's spoken reply back as audio. Speaking time is limited per day; paid plans raise the limit.

- [1. Conventions](#1-conventions)
- [2. Authentication](#2-authentication)
  - [POST /auth/google](#post-authgoogle)
  - [POST /auth/login](#post-authlogin)
- [3. User](#3-user)
  - [GET /user/me](#get-userme)
  - [PUT /user/password](#put-userpassword)
- [4. Plans](#4-plans)
  - [GET /plans](#get-plans)
- [5. Subscriptions](#5-subscriptions)
  - [GET /subscriptions](#get-subscriptions)
  - [POST /subscriptions](#post-subscriptions)
- [6. Payment callback (Multicard)](#6-payment-callback-multicard)
  - [POST /payment/handle](#post-paymenthandle)
- [7. Conversation WebSocket](#7-conversation-websocket)
- [8. Feature logic in detail](#8-feature-logic-in-detail)
  - [8.1 Conversation turn lifecycle](#81-conversation-turn-lifecycle)
  - [8.2 Daily speaking limit](#82-daily-speaking-limit)
  - [8.3 Resume after a dropped connection](#83-resume-after-a-dropped-connection)
  - [8.4 One connection per user, liveness](#84-one-connection-per-user-liveness)
  - [8.5 Conversation records and transcripts](#85-conversation-records-and-transcripts)
  - [8.6 Subscriptions and payments](#86-subscriptions-and-payments)
  - [8.7 Sign-in, passwords and the login rate limit](#87-sign-in-passwords-and-the-login-rate-limit)
  - [8.8 AI pipeline and provider resilience](#88-ai-pipeline-and-provider-resilience)
- [9. Data model](#9-data-model)
- [10. Configuration](#10-configuration)
- [11. Testing tools](#11-testing-tools)

---

## 1. Conventions

| | |
|---|---|
| Base URL | `http(s)://<host>:<PORT>` (HTTP), `ws(s)://<host>:<PORT>/v1/conversation` (WebSocket) |
| Body format | JSON (`Content-Type: application/json`) |
| Auth | `Authorization: Bearer <accessToken>` on protected routes and on the WebSocket |
| IDs | UUID v4 strings |
| Dates | ISO 8601 UTC, e.g. `"2026-11-09T12:00:00.000Z"` |
| Money | `price` in **UZS** (so'm, number); `amount` in **tiyin** (integer, `price × 100`) |

### Validation

Every request body is validated (`whitelist`, `forbidNonWhitelisted`, `transform`): wrong types and **unknown fields** are rejected with 400. The exception is `POST /payment/handle`, which accepts Multicard's full payload.

### Error format

Errors use Nest's standard shape:

```json
{ "statusCode": 401, "message": "Invalid email or password", "error": "Unauthorized" }
```

Validation errors list every problem:

```json
{
  "statusCode": 400,
  "message": ["email must be an email", "property foo should not exist"],
  "error": "Bad Request"
}
```

| Status | Meaning |
|---|---|
| 400 | Invalid body |
| 401 | Missing/invalid access token, or bad credentials |
| 404 | Resource (user, plan) not found |
| 429 | Rate-limited (`POST /auth/login`), see `Retry-After` |
| 502 | An upstream service (Google, Multicard) failed |

### Static pages

`GET /privacy_policy` serves `public/privacy_policy.html` (the `.html` extension is optional).

---

## 2. Authentication

Both sign-in methods return the same response. The `accessToken` is an HS256 JWT (`{ sub: userId }`) valid for **365 days**. There are no refresh tokens and no revocation: the client keeps the token and sends it as `Authorization: Bearer <accessToken>`.

The HTTP guard checks only the token's signature and expiry, not that the user still exists (routes that need the user return 404 when it is gone). The WebSocket additionally checks that the user exists.

### POST /auth/google

Sign in, or sign up on first use, with a Google ID token from the client's Google Sign-In.

**Request**

```http
POST /auth/google
Content-Type: application/json

{ "idToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6..." }
```

| Field | Type | Rules |
|---|---|---|
| `idToken` | string | a JWT, max 4096 chars |

**Response 200**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "5b1e4c1a-8f0e-4a51-9a3e-2f7f0f6f1c11",
    "firstName": "Ann",
    "lastName": "Lee",
    "email": "ann@example.com"
  }
}
```

**Errors**

| Status | When |
|---|---|
| 400 | `idToken` missing or not a JWT |
| 401 | `Invalid Google ID token`: Google rejected it, it expired, the issuer isn't Google, or `aud` isn't one of `GOOGLE_CLIENT_IDS` |
| 502 | `Google is unavailable`: network error, timeout (10 s), or 5xx from Google |

**Logic**

1. The token is checked with `https://oauth2.googleapis.com/tokeninfo`. Google verifies the signature and expiry; the server also requires `iss` = Google, `aud` ∈ `GOOGLE_CLIENT_IDS` (without this, a token issued to *any* app would be accepted), a `sub`, and a future `exp`.
2. Profile: `firstName` = `given_name`, else `name`, else the email's local part, else `"User"`. `lastName` = `family_name` or null. `email` is kept only if `email_verified` is true, trimmed and lowercased.
3. Upsert by Google account id (`INSERT ... ON CONFLICT (google_id) DO UPDATE`): the profile is refreshed on every sign-in, and two concurrent first sign-ins can't create two users.
4. Emails are unique. If another user already has this email, the account is saved **without** an email instead of failing.

### POST /auth/login

Sign in with email and password. Only for **existing** users who have set a password with [`PUT /user/password`](#put-userpassword) (there is no email sign-up).

**Request**

```http
POST /auth/login
Content-Type: application/json

{ "email": "ann@example.com", "password": "correct horse battery" }
```

| Field | Type | Rules |
|---|---|---|
| `email` | string | valid email, max 254 chars; case and surrounding spaces are ignored |
| `password` | string | 1–128 chars |

**Response 200**: same as `POST /auth/google`.

**Errors**

| Status | When |
|---|---|
| 400 | Invalid body |
| 401 | `Invalid email or password`: unknown email, user without a password, or wrong password (always the same message) |
| 429 | Too many attempts (see below) |

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 840

{
  "statusCode": 429,
  "message": "Too many sign-in attempts, try again later",
  "retryAfterSec": 840
}
```

**Logic**: see [8.7](#87-sign-in-passwords-and-the-login-rate-limit).

---

## 3. User

Both routes require `Authorization: Bearer <accessToken>`.

### GET /user/me

The current user's profile.

```http
GET /user/me
Authorization: Bearer eyJhbGciOi...
```

**Response 200**

```json
{
  "id": "5b1e4c1a-8f0e-4a51-9a3e-2f7f0f6f1c11",
  "firstName": "Ann",
  "lastName": "Lee",
  "email": "ann@example.com",
  "hasPassword": false
}
```

| Field | Meaning |
|---|---|
| `email` | null if Google didn't report a verified email (or another account already uses it) |
| `hasPassword` | whether a password is set, i.e. whether `POST /auth/login` can work. The hash itself is never returned |

**Errors**: 401 (token), 404 `User not found` (the token is valid but the user was deleted).

### PUT /user/password

Sets or replaces the password. The old password is **not** required (the user is already authenticated).

```http
PUT /user/password
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "password": "correct horse battery" }
```

| Field | Type | Rules |
|---|---|---|
| `password` | string | 8–128 chars |

**Response 204** (no body).

**Errors**: 400, 401, 404 `User not found`.

**Logic**: stored as `scrypt$<salt>$<hash>` (random 16-byte salt, 64-byte key, base64). The column is never selected unless a query asks for it explicitly, so the hash can't leak through other endpoints.

---

## 4. Plans

### GET /plans

Public, no auth. All plans, cheapest first (ties by name).

```http
GET /plans
```

**Response 200**

```json
[
  {
    "id": "0d6a1d7e-3f3c-4a4b-9a8a-6a1f0f5d2b10",
    "name": "Monthly",
    "price": 49000,
    "durationDays": 30,
    "dailyLimitSeconds": 3600,
    "createdAt": "2026-10-01T09:00:00.000Z",
    "updatedAt": "2026-10-01T09:00:00.000Z"
  },
  {
    "id": "8c2f5b0e-1d7a-4f39-b0c6-3b9e2a7c4d55",
    "name": "Yearly",
    "price": 399000,
    "durationDays": 365,
    "dailyLimitSeconds": 7200,
    "createdAt": "2026-10-01T09:00:00.000Z",
    "updatedAt": "2026-10-01T09:00:00.000Z"
  }
]
```

| Field | Meaning |
|---|---|
| `price` | UZS (so'm) |
| `durationDays` | length of one paid period |
| `dailyLimitSeconds` | speaking time per day while subscribed to this plan |

There is no API to create or edit plans: insert them into the `plans` table directly.

---

## 5. Subscriptions

Both routes require `Authorization: Bearer <accessToken>`.

### GET /subscriptions

The user's **paid** subscriptions that haven't ended yet, in start order, each with its plan. This includes renewals queued to start after the current one.

```http
GET /subscriptions
Authorization: Bearer eyJhbGciOi...
```

**Response 200**

```json
[
  {
    "id": "a3b9e7f2-6c41-4b8e-9d2a-1f0c7e5b3a90",
    "userId": "5b1e4c1a-8f0e-4a51-9a3e-2f7f0f6f1c11",
    "planId": "0d6a1d7e-3f3c-4a4b-9a8a-6a1f0f5d2b10",
    "isActive": true,
    "startDate": "2026-11-01T10:15:00.000Z",
    "endDate": "2026-12-01T10:15:00.000Z",
    "createdAt": "2026-11-01T10:14:12.000Z",
    "updatedAt": "2026-11-01T10:15:00.000Z",
    "plan": {
      "id": "0d6a1d7e-3f3c-4a4b-9a8a-6a1f0f5d2b10",
      "name": "Monthly",
      "price": 49000,
      "durationDays": 30,
      "dailyLimitSeconds": 3600,
      "createdAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-01T09:00:00.000Z"
    }
  }
]
```

An empty array means no paid time. The subscription "in force" right now is the one with `startDate <= now < endDate`.

### POST /subscriptions

Starts a purchase: creates an unpaid subscription and a Multicard invoice, and returns the checkout URL.

```http
POST /subscriptions
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "planId": "0d6a1d7e-3f3c-4a4b-9a8a-6a1f0f5d2b10" }
```

**Response 201**

```json
{
  "subscriptionId": "a3b9e7f2-6c41-4b8e-9d2a-1f0c7e5b3a90",
  "invoiceId": "f1c2d3e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "amount": 4900000,
  "checkoutUrl": "https://checkout.multicard.uz/invoice/..."
}
```

| Field | Meaning |
|---|---|
| `amount` | tiyin (`price × 100`) |
| `checkoutUrl` | open it in the app (browser/WebView) to pay |

**Errors**: 400 (`planId` not a UUID), 401, 404 `Plan not found`, 502 `Payment provider rejected the request` (the invoice is then marked `failed`).

The subscription becomes active only when Multicard calls [`POST /payment/handle`](#post-paymenthandle). After payment, poll `GET /subscriptions` (or reconnect the WebSocket) to see the new limit. Unpaid subscriptions simply stay inactive.

---

## 6. Payment callback (Multicard)

### POST /payment/handle

Called **by Multicard** after a successful payment, not by the app. `RHMT_CALLBACK_URL` must be this route's public URL.

**Request** (Multicard sends more fields; these are the ones used)

```json
{
  "store_id": 6,
  "invoice_id": "f1c2d3e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "amount": 4900000,
  "uuid": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "sign": "5d41402abc4b2a76b9719d911017c592"
}
```

**Response**: always HTTP 200.

```json
{ "success": true }
```

```json
{ "success": false, "message": "Amount mismatch" }
```

| Reply | What Multicard does |
|---|---|
| `success: true` | keeps the payment |
| `success: false`, or a non-200 | **cancels and refunds** the payment |
| HTTP 500 or timeout | retries the callback later |

**Checks, in order** (the first failure answers `success: false` with this message):

| # | Check | Message |
|---|---|---|
| 1 | `store_id` number/string, `invoice_id`/`uuid`/`sign` strings, `amount` number | `Invalid payload` |
| 2 | `sign == md5(store_id + invoice_id + amount + RHMT_SECRET)`, case-insensitive, timing-safe | `Invalid signature` |
| 3 | `store_id == RHMT_STORE_ID` | `Unknown store` |
| 4 | invoice exists (`invoice_id` is a UUID and in the DB) | `Invoice not found` |
| 5 | `amount` equals the invoice amount | `Amount mismatch` |
| 6 | invoice already paid with the **same** `uuid` → `success: true` (idempotent repeat); with a **different** `uuid` | `Invoice already paid` |

On success, in one transaction with the invoice row locked: the invoice becomes `paid` (`rhmtUuid`, `paidAt`), and the subscription is activated (see [8.6](#86-subscriptions-and-payments)). An unexpected error (e.g. the DB is down) gives a 500, so Multicard retries.

---

## 7. Conversation WebSocket

```
ws(s)://<host>/v1/conversation[?resume=<conversationId>]
Authorization: Bearer <accessToken>
```

The token must be in the **header**. `?token=` is not accepted, because query strings end up in proxy and access logs. Max frame size: 64 KB.

### Connection flow

```
client                                   server
  │── upgrade + Authorization ───────────►│ verify token + user exists      (else close 4401)
  │                                       │ close the user's previous socket (4409)
  │                                       │ compute today's remaining time   (none → limit_reached, 4403)
  │                                       │ create / reopen Conversation row
  │                                       │ open speech recognition
  │◄────────────── {"type":"ready",...} ──│
  │── binary PCM16 16 kHz (mic) ─────────►│
  │◄──── {"type":"transcript_interim"} ───│ (repeated while speaking)
  │── {"type":"end_of_audio"} (optional) ►│
  │◄──── {"type":"transcript_final"} ─────│ user turn saved
  │◄──── {"type":"llm_delta"} ... ────────│ reply text streams in
  │◄──── {"type":"tts_start","sampleRate":24000}
  │◄──── binary PCM16 24 kHz (AI voice) ──│
  │◄──── {"type":"llm_done"} ─────────────│
  │◄──── {"type":"tts_end"} ──────────────│ AI turn saved
```

**Frames sent before `ready` are dropped** (they arrive while the server is still authenticating). Start streaming the mic after `ready`.

### Client → server

| Frame | Meaning |
|---|---|
| binary | Mic audio: PCM s16le, **16 kHz, mono**, about 100 ms per frame (3200 bytes) |
| `{"type":"end_of_audio"}` | User stopped talking (push-to-talk release or client VAD). Optional: the server also detects silence itself (`STT_SILENCE_MS`). It finalizes the utterance faster. Audio sent afterwards is still transcribed |
| `{"type":"interrupt"}` | Stop the AI's current reply (barge-in button) |
| `{"type":"ping"}` | Application-level ping, answered with `pong` |

Unknown or malformed text frames get `{"type":"error","message":"unknown message","retryable":false}`.

### Server → client

Clients must ignore unknown `type`s. Binary frames are AI voice: PCM s16le mono at the `sampleRate` from `tts_start` (24000).

| Message | Example | Meaning |
|---|---|---|
| `ready` | `{"type":"ready","remainingSec":1740,"conversationId":"c0ffee00-...","resumed":true}` | Session is live. `remainingSec`: speaking time left today (the server disconnects when it runs out). `conversationId`: keep it for `?resume=`. `resumed` only present when a resume was accepted |
| `transcript_interim` | `{"type":"transcript_interim","text":"I went to the"}` | Partial recognition of the current utterance |
| `transcript_final` | `{"type":"transcript_final","turnId":3,"text":"I went to the park yesterday."}` | Final user utterance; starts a new turn |
| `llm_delta` | `{"type":"llm_delta","turnId":3,"text":"Oh nice, "}` | A piece of the reply text |
| `llm_done` | `{"type":"llm_done","turnId":3,"text":"Oh nice, what did you do there?"}` | Full reply text |
| `tts_start` | `{"type":"tts_start","turnId":3,"sampleRate":24000}` | Voice audio for this turn follows |
| `tts_end` | `{"type":"tts_end","turnId":3}` | All audio of the turn has been sent |
| `tts_stop` | `{"type":"tts_stop","turnId":3}` | Barge-in: **flush the playback buffer now** |
| `status` | `{"type":"status","stt":"reconnecting"}` / `{"type":"status","stt":"ok"}` | Speech recognition is reconnecting upstream. Keep the mic on: audio is buffered and replayed |
| `limit_reached` | `{"type":"limit_reached"}` | Daily allowance used up; close 4403 follows |
| `error` | `{"type":"error","message":"failed to generate a reply","retryable":true}` | See below |
| `turn_metrics` | `{"type":"turn_metrics","turnId":3,"conversationId":"...","finalLagMs":180,"final":0,"llmFirstToken":420,"firstSentence":610,"ttsFirstChunk":1350,"firstAudioSent":1352,"llmDone":900,"ttsEnd":4100,"served":{"llm":"gemini:gemini-3.6-flash","tts":"gemini:gemini-3.8-flash-tts"}}` | Only with `SEND_TURN_METRICS=true`. Milliseconds since the final transcript |
| `pong` | `{"type":"pong"}` | Reply to `ping` |

`error` messages:

| `message` | `retryable` | What follows |
|---|---|---|
| `unknown message` | false | nothing, the session continues |
| `failed to generate a reply` | true | the session continues; the user can speak again |
| `speech recognition unavailable` | true | close 1011 |
| `failed to start the conversation` | true | close 1011 |

### Close codes

| Code | Meaning | Client action |
|---|---|---|
| 1000 | Normal | — |
| 1011 | Speech recognition unavailable, or the conversation failed to start | Reconnect with `?resume=` after a short delay |
| 4401 | Missing/invalid token, or user deleted | Sign in again |
| 4403 | Daily limit reached | Show the paywall / "come back tomorrow" |
| 4409 | Replaced by a newer connection of the same user | Don't reconnect automatically (another device/tab took over) |

The server also sends WebSocket **ping frames** every `WS_PING_MS` (15 s). Standard clients pong automatically; a peer that misses one is terminated.

### Example session (JS)

```js
const ws = new WebSocket(`wss://api.example.com/v1/conversation${resumeId ? `?resume=${resumeId}` : ''}`, {
  headers: { Authorization: `Bearer ${accessToken}` }, // Node `ws`; in RN use the headers option of your WS lib
});
ws.binaryType = 'arraybuffer';
ws.onmessage = ({ data }) => {
  if (data instanceof ArrayBuffer) return player.enqueue(new Int16Array(data)); // 24 kHz PCM
  const msg = JSON.parse(data);
  switch (msg.type) {
    case 'ready': resumeId = msg.conversationId; mic.start((pcm16k) => ws.send(pcm16k)); break;
    case 'tts_stop': player.flush(); break;
    case 'limit_reached': showPaywall(); break;
  }
};
```

---

## 8. Feature logic in detail

### 8.1 Conversation turn lifecycle

Pipeline per user utterance (all Google Gemini, see [8.8](#88-ai-pipeline-and-provider-resilience)):

```
mic PCM16 16k ─► STT (Live API) ─► final transcript ─► LLM stream ─► sentence splitter ─► TTS per sentence ─► PCM16 24k
```

1. **Speech recognition** runs for the whole connection. Interim text is relayed as `transcript_interim`. An utterance is finalized by the server's voice activity detection after `STT_SILENCE_MS` (500 ms) of silence, or sooner after the client's `end_of_audio`. Recognition language is pinned by `STT_LANGUAGES` (default `en-US`).
2. **A final transcript starts a turn.** Any reply still in progress is interrupted first (barge-in). If the previous user utterance never got an answer, the two are merged into one user turn for the AI.
3. **The AI reply** is generated from the system prompt (a friendly English conversation partner: short spoken sentences, ends with a follow-up question, corrects at most one important mistake gently) and the last **20** turns of history.
4. **Sentence splitting.** The reply text is cut into sentences as it streams (min 20 chars). The first chunk is cut at a clause boundary (`, ; : —`) if no sentence ends within 60 chars, so voice starts sooner.
5. **Text-to-speech per sentence.** Each sentence is synthesized as soon as it is ready (in parallel), but audio is sent **strictly in order**. A sentence that still fails after retries is **skipped**: the user hears the rest, and the text is on screen anyway. The turn fails (`error: failed to generate a reply`) only if no sentence produced audio.
6. **Barge-in.** A new final transcript or an `interrupt` message aborts the turn and sends `tts_stop`. History keeps only the sentences that were fully spoken, so the AI knows what the user actually heard.
7. **Timing.** Each turn logs one JSON line `{"evt":"turn",...}` with the marks above (no transcript text). `finalLagMs` is the delay from the client's `end_of_audio` (or the last interim) to the final transcript; `served` names the model that answered.

### 8.2 Daily speaking limit

- **Day** = calendar day in `USAGE_TIMEZONE` (default `UTC`, e.g. `Asia/Tashkent`).
- **Limit** = the in-force subscription's `plan.dailyLimitSeconds`, else `DAILY_LIMIT_SECONDS` (free tier), and never less than the free tier. "In force" means paid with `startDate <= now < endDate`; a queued renewal doesn't count yet.
- **Usage** = sum of today's conversation durations, computed in one SQL query:
  - a conversation that crossed midnight counts only from midnight;
  - an open conversation counts up to `min(now, updatedAt + 30 s)`. Live connections bump `updatedAt` every 30 s (heartbeat), so a conversation orphaned by a server crash stops counting ~30 s after its last heartbeat.
- **At connect**: `remaining = limit − usage`. If ≤ 0 → `limit_reached` + close 4403. Otherwise `ready.remainingSec` reports it and a timer sends `limit_reached` + 4403 when it runs out (including when the conversation crosses midnight).
- The limit is read **once per connection**: buying a plan mid-conversation applies on the next connection; a subscription expiring mid-conversation doesn't cut it short.

### 8.3 Resume after a dropped connection

- Reconnect with `?resume=<conversationId>` (from `ready`).
- Accepted if the conversation belongs to the user and is still open or ended less than `RESUME_WINDOW_SEC` (120 s) ago. Then the row is reopened, its last 20 turns are loaded as AI context, and `ready.resumed` is `true`.
- Otherwise (unknown id, someone else's, too old) a **new** conversation starts silently. A bad id never fails the connection.
- If the old connection is still being closed on the server, the resume waits for that to finish, so the old "ended" write can't land after the reopen.
- The gap between disconnect and resume counts as used time (usage is measured from the conversation's start).

### 8.4 One connection per user, liveness

- **One live connection per user.** A new connection closes the previous one with 4409 and ends its conversation *before* usage is computed, so parallel sockets can't each spend the full remaining allowance.
- **Ping/pong.** The server pings every `WS_PING_MS` (15 s) and terminates a peer that missed the previous pong, so a dead phone can't hold a session (and spend its allowance) until TCP times out.
- **Slow readers.** A client with more than 1 MB of unsent audio (~20 s, i.e. it stopped reading) is terminated.
- **Speech recognition drops** are handled server-side: it reconnects with backoff for up to `STT_RECONNECT_BUDGET_MS` (20 s), sending `status: reconnecting` / `ok`, and replays the last ≤ `STT_REPLAY_BUFFER_MS` (5 s) of audio. Only when that budget is spent (or on an auth error) does the client get `speech recognition unavailable` + 1011.
- All of this is **in memory per process**. Running several instances needs a shared lock (Redis / Postgres advisory lock) for the one-connection rule.

### 8.5 Conversation records and transcripts

- Each accepted connection is a `Conversation` row: `startedAt` when accepted, `endedAt` on disconnect (idempotent). Conversations still open at a graceful shutdown are ended; only a crash leaves `endedAt` null.
- Each final user transcript is a `user` `Turn`. Each AI reply is an `ai` turn once fully spoken; on barge-in or disconnect only the fully spoken sentences are saved (nothing if none were).
- A connection's turn inserts are chained, so they are stored in order and flushed before `endedAt` is written. Order turns by `createdAt`.
- Raw audio is never stored.

### 8.6 Subscriptions and payments

```
app                      hiapp-api                         Multicard
 │ POST /subscriptions ──►│ subscription (inactive)
 │                        │ invoice (pending, amount tiyin)
 │                        │── POST /auth (token cached ~24h) ─►│
 │                        │── POST /payment/invoice ──────────►│ { uuid, checkout_url }
 │◄── { checkoutUrl } ────│
 │── opens checkoutUrl, pays ─────────────────────────────────►│
 │                        │◄── POST /payment/handle (signed) ──│
 │                        │ verify → invoice paid → activate    │
 │                        │── 200 { success: true } ──────────►│
 │ GET /subscriptions ───►│ (now shows the paid period)
```

- **Amount**: `Math.round(plan.price × 100)` tiyin; `invoice_id` sent to Multicard is our invoice UUID.
- **Multicard auth**: `POST {RHMT_API_URL}/auth` with `{ application_id, secret }` gives a JWT valid ~24 h, cached in memory and shared by concurrent callers. A 401 triggers one re-auth and retry. Multicard can report errors with HTTP 200 and `success: false`; any failure becomes 502 and the invoice is marked `failed`.
- **Activation**: the subscription gets `isActive = true`, `startDate`, `endDate = startDate + durationDays`.
- **Renewals stack**: if the user still has paid time, the new period starts at the latest active `endDate`, otherwise now, so renewing early loses nothing. The user row is locked during activation, so two payments landing at once can't both start at the same moment.
- **Idempotency**: the invoice row is locked for the whole callback; a repeat with the same `uuid` succeeds without changes, a different `uuid` on a paid invoice is refused (refunded).

### 8.7 Sign-in, passwords and the login rate limit

- **Passwords** are optional and set by an authenticated user (`PUT /user/password`, no old password needed). Stored as scrypt hashes, never returned.
- **Emails** are stored trimmed and lowercased and are **unique** (several users may have none). They come only from Google, and only when verified; there is no API to change them.
- **`POST /auth/login`**:
  1. The email is normalized (trim + lowercase).
  2. The rate limiter records the attempt (below). If blocked → 429.
  3. The user is looked up by email with the password hash.
  4. The password is verified with scrypt in constant time. If the email is unknown or the user has no password, scrypt still runs against a dummy hash, so response time doesn't reveal which emails exist.
  5. Any failure → the same 401 `Invalid email or password`. Success → resets the email's counter and returns a token.
- **Rate limit** (fixed windows, in memory per process):

  | Key | Limit (default) | Counts | Reset |
  |---|---|---|---|
  | email | `AUTH_LOGIN_MAX_PER_EMAIL` = 5 per `AUTH_LOGIN_WINDOW_SEC` = 900 s | every attempt that isn't blocked | window end, or a successful sign-in |
  | client IP | `AUTH_LOGIN_MAX_PER_IP` = 20 per 900 s | every attempt that isn't blocked, success or not | window end |

  - Attempts count when they **start**, so parallel requests can't race past the limit while their password checks run.
  - Blocked attempts don't count (a locked-out client doesn't extend its own lock).
  - The email key counts whether or not the account exists, so the limiter doesn't reveal accounts either.
  - `Retry-After` / `retryAfterSec` = seconds until the blocking window ends.
  - **Behind a reverse proxy set `TRUST_PROXY`** (e.g. `1`), otherwise every client is seen as the proxy's IP and shares one 20-attempt budget.

### 8.8 AI pipeline and provider resilience

All AI goes through Google Gemini via `@google/genai`, behind three ports (`STT`, `LLM`, `TTS`) so orchestration code doesn't depend on the provider.

**Backend** (`GENAI_BACKEND`):

| Value | Service | Credentials |
|---|---|---|
| `gemini` (default) | Gemini Developer API | `GEMINI_API_KEY` |
| `vertex` | Vertex AI | service-account JSON key `GOOGLE_CREDENTIALS_FILE` (default `google-service-account.json` in the project root, gitignored, role `roles/aiplatform.user`); project from the key's `project_id` or `GOOGLE_CLOUD_PROJECT`; `GOOGLE_CLOUD_LOCATION` (default `global`) |

A missing/invalid key file fails at startup.

| Stage | API | Models (default) |
|---|---|---|
| STT | Live API (`live.connect`) with input transcription and server voice-activity detection | `STT_MODEL` = `gemini-3.5-transcribe-live` |
| LLM | `generateContentStream` (max 400 output tokens, minimal thinking) | `LLM_MODELS` = `gemini-3.6-flash,gemini-3.5-flash-lite` (fallback chain) |
| TTS | Gemini backend: Interactions API, streaming `audio/l16`. Vertex: `generateContentStream` with audio output (the Interactions API rejects TTS models on Vertex) | `TTS_MODELS` = `gemini-3.8-flash-tts`, voice `TTS_VOICE` = `Kore`, 24 kHz |

**Resilience**:

- Every provider error is classified: `overloaded`, `rate_limited`, `timeout`, `network`, `auth`, `bad_request`, `unknown`. `auth` and `bad_request` are never retried. A server retry hint (`retry-after` header, `RetryInfo`, or "retry in 2h9m16s") is honoured.
- **Fallback chains**: each attempt has a first-result deadline. Before the first result, a failure retries or moves to the next model; after it, the error is passed on (the user already got part of the reply).
- **Circuit breakers** per model: 5 retryable failures in 30 s, or a retry hint ≥ 20 s, open it; an open model is skipped until a half-open trial. If all are open, all are tried anyway.
- **LLM**: no first token within `LLM_FIRST_TOKEN_MS` (2.5 s) or a 429 → next model at once; `overloaded`/`network` get one jittered retry first.
- **TTS**: `TTS_RETRIES` (2) extra attempts per model and sentence, each with a `TTS_FIRST_CHUNK_MS` (2.5 s) deadline. A 429 asking to wait more than 1.5 s isn't retried. All TTS models must output the same sample rate.
- **STT**: reconnect with jittered backoff and audio replay (see [8.4](#84-one-connection-per-user-liveness)); a server `goAway` is handled make-before-break (new connection first, the old one's last transcript still accepted).
- **Fault injection** (testing only): `AI_FAULT_RATE` = probability of injected 503s / STT drops on every AI call.

---

## 9. Data model

PostgreSQL; snake_case columns; every table has `created_at` / `updated_at`.

| Table | Columns | Notes |
|---|---|---|
| `users` | `id`, `first_name`, `last_name?`, `email?` (unique, lowercased), `google_id?` (unique), `password?` (scrypt hash, never selected by default) | |
| `plans` | `id`, `name`, `price` numeric(12,2) UZS, `duration_days`, `daily_limit_seconds` (default 3600) | managed directly in the DB |
| `subscriptions` | `id`, `user_id` → users (cascade), `plan_id` → plans (restrict), `is_active` (default false), `start_date?`, `end_date?` | index (`user_id`, `end_date`) |
| `invoices` | `id` (= Multicard `invoice_id`), `subscription_id` → subscriptions (cascade), `amount` bigint tiyin, `status` `pending`/`paid`/`failed`, `rhmt_uuid?`, `checkout_url?`, `paid_at?` | |
| `conversations` | `id`, `user_id` → users (cascade), `started_at`, `ended_at?` | index (`user_id`, `started_at`); `updated_at` is the heartbeat |
| `turns` | `id`, `conversation_id` → conversations (cascade), `role` `user`/`ai`, `text` | index (`conversation_id`, `created_at`) |

The schema is synchronized from the entities on startup (no migrations).

---

## 10. Configuration

`.env` in the project root (see `.env.example`).

**Required**

| Variable | Meaning |
|---|---|
| `PORT` | HTTP/WebSocket port |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL |
| `JWT_SECRET` | access-token signing key |
| `GOOGLE_CLIENT_IDS` | comma-separated OAuth client IDs (Android, iOS, web) accepted as `aud` |
| `GEMINI_API_KEY` | only with `GENAI_BACKEND=gemini` |
| `DAILY_LIMIT_SECONDS` | free-tier speaking seconds per day |
| `RHMT_API_URL`, `RHMT_APPLICATION_ID`, `RHMT_SECRET`, `RHMT_STORE_ID`, `RHMT_CALLBACK_URL` | Multicard |

**Optional** (default)

| Variable | Default | Meaning |
|---|---|---|
| `USAGE_TIMEZONE` | `UTC` | timezone whose midnight resets the daily limit |
| `GENAI_BACKEND` | `gemini` | `gemini` or `vertex` |
| `GOOGLE_CREDENTIALS_FILE` | `google-service-account.json` | Vertex key, relative to the project root |
| `GOOGLE_CLOUD_PROJECT` | key's `project_id` | Vertex project |
| `GOOGLE_CLOUD_LOCATION` | `global` | Vertex region |
| `STT_MODEL` | `gemini-3.5-transcribe-live` | |
| `STT_LANGUAGES` | `en-US` | comma-separated BCP-47 codes, empty = auto-detect |
| `STT_SILENCE_MS` | `500` | silence before an utterance is finalized |
| `STT_RECONNECT_BUDGET_MS` | `20000` | give up (1011) after this long unreachable |
| `STT_REPLAY_BUFFER_MS` | `5000` | audio replayed after a reconnect |
| `LLM_MODELS` | `gemini-3.6-flash,gemini-3.5-flash-lite` | fallback chain |
| `LLM_FIRST_TOKEN_MS` | `2500` | first-token deadline per model |
| `TTS_MODELS` | `gemini-3.8-flash-tts` | fallback chain, same sample rate |
| `TTS_VOICE` | `Kore` | |
| `TTS_RETRIES` | `2` | extra attempts per model and sentence |
| `TTS_FIRST_CHUNK_MS` | `2500` | first-chunk deadline per attempt |
| `AUTH_LOGIN_MAX_PER_EMAIL` | `5` | login attempts per email per window |
| `AUTH_LOGIN_MAX_PER_IP` | `20` | login attempts per IP per window |
| `AUTH_LOGIN_WINDOW_SEC` | `900` | login rate-limit window |
| `TRUST_PROXY` | off | `true`, a hop count, or an Express trust value; set behind a reverse proxy |
| `WS_PING_MS` | `15000` | WebSocket ping interval |
| `RESUME_WINDOW_SEC` | `120` | how long a dropped conversation can be resumed |
| `SEND_TURN_METRICS` | `false` | send `turn_metrics` to the client |
| `AI_FAULT_RATE` | `0` | testing only: injected AI failures (0–1) |

---

## 11. Testing tools

```bash
# Stream a 16 kHz mono PCM16 file into a conversation; the reply is written to out.pcm (24 kHz)
TOKEN=<accessToken> node scripts/test-client.mjs input.pcm [ws://localhost:3000/v1/conversation]

# Play the reply
ffplay -f s16le -ar 24000 -ac 1 out.pcm

# Make a 16 kHz input file from any audio
ffmpeg -i speech.m4a -f s16le -ar 16000 -ac 1 input.pcm
```
