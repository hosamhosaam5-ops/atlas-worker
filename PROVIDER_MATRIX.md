# ATLAS Worker — PROVIDER MATRIX (M6A item 4)

| Provider | MOCK | LIVE adapter written | LIVE integration tested | Secret required | Needs account | Needs founder approval | Needs money |
|---|---|---|---|---|---|---|---|
| Telegram Bot API | ✅ | ✅ (core/outbox.js LIVE) | ❌ never sent a real message | `TELEGRAM_BOT_TOKEN` | existing bot | YES | no |
| OpenRouter (AI) | ✅ | ✅ (ceo/provider.js OPENROUTER) | ❌ zero real calls | `OPENROUTER_API_KEY` | existing | YES | free tier OK |
| Brave Search | ✅ | ✅ (ceo/webresearch.js LIVE) | ❌ zero real calls | `BRAVE_API_KEY` | yes (free 2k/mo) | YES | no |
| Email (Resend HTTPS) | ✅ | ✅ (orders/email.js RESEND) | ❌ never sent | `RESEND_API_KEY` + `EMAIL_FROM` | YES — new account | YES | free tier OK |
| Base RPC (payment) | ✅ synthetic receipts | ✅ (orders/payment.js BASE_RPC) | ❌ never hit a real tx | none (public RPC) | no | YES (frozen by founder) | no — read-only |
| datapoint.market (SIWE) | ✅ | ✅ (bridges/siwe.js LIVE) | ❌ never called | none | no | YES | no |
| BountyBook | ✅ | ✅ (bridges/bountybook.js LIVE) | ❌ never called | runtime session token only | no | YES | no |
| ChatGPT bridge | ✅ header auth | ✅ (bridges/chatgpt.js) | ✅ auth/contract tested locally | `CHATGPT_BRIDGE_SECRET` | no | YES | no |
| File storage | ✅ LOCAL (D1 order_files) | ✅ (orders/storage.js R2) | ❌ R2 never written | R2 binding | Cloudflare account | YES | free quota OK |

## What still needs a REAL test after deploy (item 9 detail)

1. Telegram LIVE: one real `sendMessage` to founder chat → must show provider_message_id, outbox SENT.
2. OpenRouter LIVE: one real completion inside CEO pipeline (AI1) → honest Arabic reply.
3. Brave LIVE: one real query → real snippets; 429 path must still classify RATE_LIMIT.
4. Resend LIVE: one real email with 2 attachments to founder's own address → SENT.
5. Base RPC LIVE: read one REAL founder-approved tx receipt → PAID classification (FROZEN — no real tx exists; founder will not fund).
6. SIWE LIVE: real challenge fetch → signing page renders real message.
7. BountyBook LIVE: real authVerify with a real signature (needs a signing event — founder action).
8. R2 LIVE: put/get one order file round-trip.
