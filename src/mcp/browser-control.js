import { acquire, connect } from "@cloudflare/playwright";
import { validateAction, validatePublicHttpsUrl } from "./browser-policy.js";

const MAX_ACTIONS = 6;
const MAX_TEXT = 12000;
const NAVIGATION_TIMEOUT_MS = 10000;
const SESSION_IDLE_MS = 20 * 60 * 1000;
const SESSION_KEY = "founder-main";
const MAX_CALLS_PER_DAY = 20;
const MAX_LAUNCHES_PER_DAY = 3;

export async function handleBrowserControl(env, args) {
  if (!env.BROWSER) throw new Error("BROWSER_RUN_BINDING_NOT_CONFIGURED");
  const initialUrl = validatePublicHttpsUrl(args?.url);
  const rawActions = Array.isArray(args?.actions) ? args.actions : [];
  if (rawActions.length > MAX_ACTIONS) throw new Error("BROWSER_ACTION_LIMIT_EXCEEDED");
  const actions = rawActions.map(validateAction);
  const day = new Date().toISOString().slice(0, 10);

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS browser_control_quota (day TEXT PRIMARY KEY, launches INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  // If an earlier draft schema was ever deployed, add the calls counter without failing on repeat runs.
  try { await env.DB.prepare("ALTER TABLE browser_control_quota ADD COLUMN calls INTEGER NOT NULL DEFAULT 0").run(); } catch { /* already present */ }
  const callClaim = await env.DB.prepare(
    "INSERT INTO browser_control_quota (day, launches, calls, updated_at) VALUES (?, 0, 1, datetime('now')) ON CONFLICT(day) DO UPDATE SET calls=calls+1, updated_at=datetime('now') WHERE calls < ?"
  ).bind(day, MAX_CALLS_PER_DAY).run();
  if (Number(callClaim.meta?.changes || 0) !== 1) throw new Error("BROWSER_DAILY_CALL_LIMIT_REACHED");

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS browser_control_sessions (session_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  let session = await env.DB.prepare("SELECT session_id FROM browser_control_sessions WHERE session_key=?").bind(SESSION_KEY).first();
  let sessionId = session?.session_id ? String(session.session_id) : "";
  let browser;
  let launched = false;

  if (sessionId) {
    try {
      browser = await connect(env.BROWSER, sessionId);
    } catch {
      await env.DB.prepare("DELETE FROM browser_control_sessions WHERE session_key=?").bind(SESSION_KEY).run();
      sessionId = "";
    }
  }

  if (!browser) {
    const launchClaim = await env.DB.prepare(
      "INSERT INTO browser_control_quota (day, launches, calls, updated_at) VALUES (?, 1, 0, datetime('now')) ON CONFLICT(day) DO UPDATE SET launches=launches+1, updated_at=datetime('now') WHERE launches < ?"
    ).bind(day, MAX_LAUNCHES_PER_DAY).run();
    if (Number(launchClaim.meta?.changes || 0) !== 1) throw new Error("BROWSER_DAILY_LAUNCH_LIMIT_REACHED");
    const acquired = await acquire(env.BROWSER, { keep_alive: SESSION_IDLE_MS });
    sessionId = String(acquired.sessionId || "");
    if (!sessionId) throw new Error("BROWSER_SESSION_ID_MISSING");
    await env.DB.prepare(
      "INSERT INTO browser_control_sessions (session_key, session_id, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(session_key) DO UPDATE SET session_id=excluded.session_id, updated_at=datetime('now')"
    ).bind(SESSION_KEY, sessionId).run();
    browser = await connect(env.BROWSER, sessionId);
    launched = true;
  }

  let page;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await page.route("**/*", async route => {
      try {
        const requestUrl = route.request().url();
        if (requestUrl.startsWith("https://")) validatePublicHttpsUrl(requestUrl);
        else if (!requestUrl.startsWith("data:") && !requestUrl.startsWith("blob:") && !requestUrl.startsWith("about:")) throw new Error("BROWSER_SCHEME_BLOCKED");
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    const results = [];
    for (const action of actions) {
      if (action.type === "navigate") {
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        results.push({ action: action.type, ok: true, url: page.url() });
      } else if (action.type === "click") {
        await page.locator(action.selector).first().click();
        results.push({ action: action.type, ok: true, url: page.url() });
      } else if (action.type === "fill") {
        await page.locator(action.selector).first().fill(action.value);
        results.push({ action: action.type, ok: true });
      } else if (action.type === "press") {
        await page.locator(action.selector).first().press(action.key);
        results.push({ action: action.type, ok: true });
      } else if (action.type === "select") {
        await page.locator(action.selector).first().selectOption(action.value);
        results.push({ action: action.type, ok: true });
      } else if (action.type === "wait") {
        await page.waitForTimeout(action.ms);
        results.push({ action: action.type, ok: true });
      } else {
        results.push({ action: action.type, ok: true, url: page.url(), title: await page.title() });
      }
    }
    await env.DB.prepare("UPDATE browser_control_sessions SET updated_at=datetime('now') WHERE session_key=?").bind(SESSION_KEY).run();
    return {
      ok: true,
      url: page.url(),
      title: (await page.title()).slice(0, 500),
      text: (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_TEXT),
      actions: results,
      browser: "Cloudflare Browser Run + Playwright",
      session: { reused: !launched, idle_keep_alive_ms: SESSION_IDLE_MS },
      limits: { max_actions: MAX_ACTIONS, max_navigation_timeout_ms: NAVIGATION_TIMEOUT_MS, max_calls_per_utc_day: MAX_CALLS_PER_DAY, max_new_sessions_per_utc_day: MAX_LAUNCHES_PER_DAY }
    };
  } finally {
    // Close only this page and client connection; keep the Cloudflare-managed session and
    // its default-context cookies alive for subsequent founder-authorized calls.
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
