export function validatePublicHttpsUrl(raw) {
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

export function validateAction(action) {
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
