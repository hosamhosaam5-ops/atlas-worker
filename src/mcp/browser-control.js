import { launch } from "@cloudflare/playwright";

const MAX_ACTIONS = 10;
const MAX_TEXT = 12000;
const NAVIGATION_TIMEOUT_MS = 15000;

function validatePublicHttpsUrl(raw) {
  const u = new URL(String(raw || ""));
  if (u.protocol !== "https:") throw new Error("BROWSER_HTTPS_ONLY");
  if (u.username || u.password) throw new Error("BROWSER_URL_CREDENTIALS_FORBIDDEN");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "metadata.google.internal" || host === "169.254.169.254" ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    throw new Error("BROWSER_PRIVATE_HOST_BLOCKED");
  }
  return u.toString();
}

function validateAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("BROWSER_INVALID_ACTION");
  const type = String(action.type || "");
  if (!["navigate", "click", "fill", "press", "select", "wait", "inspect"].includes(type)) throw new Error("BROWSER_ACTION_NOT_ALLOWED");
  if (type !== "wait" && type !== "inspect" && type !== "navigate" && !String(action.selector || "").trim()) throw new Error("BROWSER_SELECTOR_REQUIRED");
  if (type === "navigate") return { type, url: validatePublicHttpsUrl(action.url) };
  if (type === "fill") return { type, selector: String(action.selector).slice(0, 500), value: String(action.value ?? "").slice(0, 2000) };
  if (type === "press") return { type, selector: String(action.selector).slice(0, 500), key: String(action.key || "Enter").slice(0, 30) };
  if (type === "select") return { type, selector: String(action.selector).slice(0, 500), value: String(action.value ?? "").slice(0, 500) };
  if (type === "click") return { type, selector: String(action.selector).slice(0, 500) };
  if (type === "wait") return { type, ms: Math.min(3000, Math.max(0, Number(action.ms || 0))) };
  return { type };
}

export async function handleBrowserControl(env, args) {
  if (!env.BROWSER) throw new Error("BROWSER_RUN_BINDING_NOT_CONFIGURED");
  const initialUrl = validatePublicHttpsUrl(args?.url);
  const rawActions = Array.isArray(args?.actions) ? args.actions : [];
  if (rawActions.length > MAX_ACTIONS) throw new Error("BROWSER_ACTION_LIMIT_EXCEEDED");
  const actions = rawActions.map(validateAction);
  // Browser Run has a documented free allowance, but usage can be billable on paid plans
  // after the included allowance. Keep each operation short and never run unattended loops.
  const browser = await launch(env.BROWSER);
  try {
    const page = await browser.newPage();
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
    const snapshot = {
      ok: true,
      url: page.url(),
      title: (await page.title()).slice(0, 500),
      text: (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_TEXT),
      actions: results,
      browser: "Cloudflare Browser Run + Playwright",
      limits: { max_actions: MAX_ACTIONS, max_navigation_timeout_ms: NAVIGATION_TIMEOUT_MS }
    };
    return snapshot;
  } finally {
    await browser.close().catch(() => {});
  }
}

export const __test = { validatePublicHttpsUrl, validateAction };
