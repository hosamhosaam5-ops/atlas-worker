# ATLAS Worker — CONFIG AUDIT (M6A item 3)

Single source of truth for every environment variable the Worker references.
No secret value is stored here or anywhere in source — names only.

## REQUIRED at deploy (must be set or the feature is OFF)

| Variable | Kind | Used by | Why required |
|---|---|---|---|
| `DB` | D1 binding | everything | primary database |
| `TELEGRAM_BOT_TOKEN` | secret | core/outbox.js (LIVE telegram) | real Telegram delivery; MOCK never sends |
| `TELEGRAM_WEBHOOK_SECRET` | secret | index.ts webhook guard | webhook is disabled (503) until configured; wrong key is rejected (403) |
| `CHATGPT_BRIDGE_SECRET` | secret | bridges/chatgpt.js | bridge is disabled (503) until configured; wrong/missing key is rejected |
| `FOUNDER_CHAT_ID` | var | crons/*.js | telegram alert destination (falls back to legacy id) |

## MOCK DEFAULT (ship as MOCK; LIVE needs a founder decision + secret)

| Variable | Default | LIVE value | Secret needed |
|---|---|---|---|
| `AI_PROVIDER` | `MOCK` | `OPENROUTER` | `OPENROUTER_API_KEY` |
| `BRAVE` | `MOCK` | `LIVE` | `BRAVE_API_KEY` |
| `TELEGRAM_PROVIDER` | `MOCK` | `LIVE` | `TELEGRAM_BOT_TOKEN` |
| `EMAIL_PROVIDER` | `MOCK` | `RESEND` | `RESEND_API_KEY`, `EMAIL_FROM` |
| `PAYMENT_PROVIDER` | `MOCK` | `BASE_RPC` | none (public RPC) |
| `FILE_STORAGE` | `LOCAL` | `R2` | R2 bucket binding |
| `DATAPOINT_PROVIDER` | `MOCK` | `LIVE` | none (public endpoint) |
| `BOUNTYBOOK_PROVIDER` | `MOCK` | `LIVE` | none (session token at runtime) |

## OPTIONAL (tuning / test seams)

| Variable | Default | Purpose |
|---|---|---|
| `AI_MOCK_SCENARIO` | `default` | local AI failure injection |
| `BRAVE_MOCK_SCENARIO` | `ok` | local Brave failure injection |
| `EMAIL_MOCK_SCENARIO` | `success` | local email failure injection |
| `PAYMENT_MOCK_SCENARIO` | `valid` | local payment receipt fixture selection |
| `TELEGRAM_MOCK_SCENARIO` | `success` | local telegram failure injection |
| `DATAPOINT_MOCK_SCENARIO` | `ok` | local SIWE challenge fixture |
| `BOUNTYBOOK_MOCK_SCENARIO` | `ok` | local BountyBook fixture |
| `EMAIL_TIMEOUT_MS` | `15000` | email provider timeout |
| `TELEGRAM_TIMEOUT_MS` | `15000` | telegram provider timeout |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base RPC override (read-only) |
| `PROCESS_SYNC` | unset | LOCAL ONLY: run CEO pipeline inline for tests. NEVER set in production. |
| `R2` | binding | file storage backend when FILE_STORAGE=R2 |

## PINNED IN CODE (not env — changing requires a founder decision)

- Recipient wallet `0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F`
- USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base Mainnet, 6 decimals)
- Network `eip155:8453`
- AI model default `nex-agi/nex-n2.5-pro:free` (pipeline.js)
- Founder chat fallback `5246182877` (crons — same as n8n backup)
