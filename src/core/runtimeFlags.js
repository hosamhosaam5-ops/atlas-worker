// Runtime test-only switches must be paired so a single accidental flag cannot activate test behavior.
export function isLocalX402TestMode(env) {
  return String(env?.X402_TEST_MODE || "") === "1"
    && String(env?.DEV_MODE || "") === "1";
}
