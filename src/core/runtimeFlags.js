// Local x402 test bootstrap must never be enabled by environment flags alone.
// Require both explicit test flags and a loopback URL so a production host stays fail-closed.
export function isLocalX402TestMode(env, requestUrl) {
  if (String(env?.X402_TEST_MODE || "") !== "1" || String(env?.DEV_MODE || "") !== "1") {
    return false;
  }

  let hostname = "";
  try {
    hostname = new URL(String(requestUrl || "")).hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
  } catch {
    return false;
  }

  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname === "::1";
}
