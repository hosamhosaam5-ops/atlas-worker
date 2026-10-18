export function hasFounderIdentity(ctx, env) {
  const oauthSub = String(ctx?.props?.login || ctx?.props?.sub || ctx?.props?.userId || "").trim();
  const founderOauthSub = String(env?.FOUNDER_OAUTH_SUB || "").trim();
  return Boolean(oauthSub && founderOauthSub && oauthSub === founderOauthSub);
}

export function assertFounderIdentity(ctx, env) {
  if (!hasFounderIdentity(ctx, env)) throw new Error("FOUNDER_IDENTITY_REQUIRED");
}

export function assertFounderCanActivateProduct(args, ctx, env) {
  const status = String(args?.status || "DRAFT").trim().toUpperCase();
  if (status === "ACTIVE") assertFounderIdentity(ctx, env);
}
