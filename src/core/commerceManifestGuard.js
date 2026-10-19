// The only currently approved paid offer has a fixed product ID and price.
// Do not advertise arbitrary caller-supplied values as if they were an active offer.
const APPROVED_PRODUCT_ID = "atlas_ai_data_qa_v1";
const APPROVED_PRICE_USDC = 15;

export function normalizeActiveCommerceManifestRequest(args = {}) {
  const product_id = args.product_id === undefined
    ? APPROVED_PRODUCT_ID
    : String(args.product_id).trim();
  const price_usdc = args.price_usdc === undefined
    ? APPROVED_PRICE_USDC
    : Number(args.price_usdc);

  if (product_id !== APPROVED_PRODUCT_ID || !Number.isFinite(price_usdc) || price_usdc !== APPROVED_PRICE_USDC) {
    throw new Error("COMMERCE_MANIFEST_OFFER_MISMATCH");
  }

  return { product_id, price_usdc };
}
