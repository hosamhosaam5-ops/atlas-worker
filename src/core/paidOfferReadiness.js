// Paid-order gates must verify operational providers, not merely the product status.
export function getPaidOfferReadinessError(env) {
  const paymentProvider = String(env?.PAYMENT_PROVIDER || "").trim().toUpperCase();
  if (paymentProvider !== "BASE_RPC") return "PAID_PAYMENT_PROVIDER_NOT_READY";

  const wallet = String(env?.ATLAS_WALLET_ADDRESS || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return "PAID_WALLET_NOT_CONFIGURED";

  const emailProvider = String(env?.EMAIL_PROVIDER || "MOCK").trim().toUpperCase();
  if (emailProvider !== "RESEND") return "PAID_DELIVERY_PROVIDER_NOT_LIVE";

  if (!String(env?.RESEND_API_KEY || "").trim() || !String(env?.EMAIL_FROM || "").trim()) {
    return "PAID_EMAIL_CONFIGURATION_REQUIRED";
  }
  return null;
}
