// Paid-order gates must verify operational providers, storage bindings, and sender-domain readiness.
export function getPaidOfferReadinessError(env) {
  const paymentProvider = String(env?.PAYMENT_PROVIDER || "").trim().toUpperCase();
  if (paymentProvider !== "BASE_RPC") return "PAID_PAYMENT_PROVIDER_NOT_READY";

  const wallet = String(env?.ATLAS_WALLET_ADDRESS || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return "PAID_WALLET_NOT_CONFIGURED";

  const storageProvider = String(env?.FILE_STORAGE || "LOCAL").trim().toUpperCase();
  if (!["LOCAL", "R2"].includes(storageProvider)) return "PAID_STORAGE_PROVIDER_NOT_READY";
  if (storageProvider === "LOCAL" && !env?.DB) return "PAID_STORAGE_PROVIDER_NOT_READY";
  if (storageProvider === "R2" && !env?.R2) return "PAID_STORAGE_PROVIDER_NOT_READY";

  const deliveryProvider = String(env?.DELIVERY_PROVIDER || "EMAIL").trim().toUpperCase();
  if (deliveryProvider === "A2A") {
    // API/A2A delivery is valid only with the already-verified D1 storage binding above.
    // The request route independently requires a claimed task + matching payment proof.
    return null;
  }
  if (deliveryProvider !== "EMAIL") return "PAID_DELIVERY_PROVIDER_NOT_LIVE";

  const emailProvider = String(env?.EMAIL_PROVIDER || "MOCK");
  if (emailProvider !== "RESEND") return "PAID_DELIVERY_PROVIDER_NOT_LIVE";

  if (!String(env?.RESEND_API_KEY || "").trim() || !String(env?.EMAIL_FROM || "").trim()) {
    return "PAID_EMAIL_CONFIGURATION_REQUIRED";
  }

  // Do not infer domain verification from a configured sender or API key.
  // Set this non-secret flag to "1" only after the sender domain's DNS/provider status
  // has been independently verified; the default is deliberately not-ready.
  if (String(env?.EMAIL_DOMAIN_VERIFIED || "") !== "1") return "PAID_EMAIL_DOMAIN_NOT_VERIFIED";

  return null;
}
