import test from "node:test";
import assert from "node:assert/strict";
import { validateAction, validatePublicHttpsUrl } from "../src/mcp/browser-policy.js";

test("browser policy allows public HTTPS URLs", () => {
  assert.equal(validatePublicHttpsUrl("https://example.com/path"), "https://example.com/path");
});

test("browser policy rejects insecure, credentialed, and private destinations", () => {
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://localhost", "https://127.0.0.1", "https://192.168.1.2", "https://169.254.169.254"]) {
    assert.throws(() => validatePublicHttpsUrl(url));
  }
});

test("browser policy rejects arbitrary code and limits wait duration", () => {
  assert.throws(() => validateAction({ type: "evaluate", code: "fetch('https://example.com')" }), /BROWSER_ACTION_NOT_ALLOWED/);
  assert.deepEqual(validateAction({ type: "wait", ms: 99999 }), { type: "wait", ms: 3000 });
  assert.throws(() => validateAction({ type: "click" }), /BROWSER_SELECTOR_REQUIRED/);
});
