import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const b64url=(b:Uint8Array)=>btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const decode=(s:string)=>{s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";return atob(s);};
async function makePkce(){const v=b64url(crypto.getRandomValues(new Uint8Array(32)));const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return {codeVerifier:v,codeChallenge:b64url(new Uint8Array(d))};}
async function verifyIdToken(env:OAuthEnv,token:string){
 const [h,p,s]=token.split(".");if(!h||!p||!s)throw new Error("INVALID_ID_TOKEN");
 const header=JSON.parse(decode(h));const claims=JSON.parse(decode(p));
 if(header.alg!=="RS256")throw new Error("INVALID_ID_TOKEN_ALG");
 const jwksUrl=new URL(env.ACCESS_JWKS_URL);
 if(jwksUrl.protocol!=="https:")throw new Error("INVALID_JWKS_URL");
 // Cloudflare Access OIDC ID tokens use the OIDC integration issuer, which is
 // the client-specific base path, not merely the team-domain origin. For a
 // JWKS URL like .../cdn-cgi/access/sso/oidc/<client-id>/jwks, the issuer is
 // the same URL without the trailing /jwks path.
 const expectedIssuer=jwksUrl.toString().replace(/\\/jwks\\/?$/i,"");
 const issuerOk=claims.iss===expectedIssuer;
 const audienceOk=Array.isArray(claims.aud)?claims.aud.includes(env.ACCESS_CLIENT_ID):claims.aud===env.ACCESS_CLIENT_ID;
 if(!issuerOk)throw new Error("INVALID_ID_TOKEN_ISSUER");
 if(!audienceOk)throw new Error("INVALID_ID_TOKEN_AUDIENCE");
 const jwksResponse=await fetch(env.ACCESS_JWKS_URL,{headers:{accept:"application/json"}});
 if(!jwksResponse.ok)throw new Error("JWKS_FETCH_FAILED");
 const jwks=await jwksResponse.json() as any;const jwk=jwks.keys?.find((k:any)=>k.kid===header.kid);if(!jwk)throw new Error("UNKNOWN_ID_TOKEN_KEY");
 const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
 const sig=Uint8Array.from(decode(s),c=>c.charCodeAt(0));
 if(!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,sig,new TextEncoder().encode(h+"."+p))))throw new Error("INVALID_ID_TOKEN_SIGNATURE");
 const now=Math.floor(Date.now()/1000);
 if(claims.exp&&claims.exp<now)throw new Error("EXPIRED_ID_TOKEN");
 if(claims.nbf&&claims.nbf>now+60)throw new Error("ID_TOKEN_NOT_YET_VALID");
 return claims;
}
// OAuth hardening verified against Cloudflare Access OIDC issuer semantics (2026-10-04).
export async function handleAccessRequest(request:Request,env:OAuthEnv,_ctx:ExecutionContext){
 const {pathname,searchParams}=new URL(request.url);
 if(request.method==="GET"&&pathname==="/authorize"){
  const info=await env.OAUTH_PROVIDER.parseAuthRequest(request);if(!info.clientId)return new Response("Invalid OAuth request",{status:400});
  const {codeVerifier,codeChallenge}=await makePkce();const state=crypto.randomUUID();
  await env.OAUTH_KV.put("oauth:state:"+state,JSON.stringify({oauthReqInfo:info,codeVerifier}),{expirationTtl:600});
  const u=new URL(env.ACCESS_AUTHORIZATION_URL);u.searchParams.set("client_id",env.ACCESS_CLIENT_ID);u.searchParams.set("redirect_uri",new URL("/callback",request.url).href);u.searchParams.set("response_type","code");u.searchParams.set("scope","openid email profile");u.searchParams.set("state",state);u.searchParams.set("code_challenge",codeChallenge);u.searchParams.set("code_challenge_method","S256");
  return Response.redirect(u.toString(),302);
 }
 if(request.method==="GET"&&pathname==="/callback"){
  const state=searchParams.get("state"),code=searchParams.get("code");if(!state||!code)return new Response("Missing OAuth callback parameters",{status:400});
  const raw=await env.OAUTH_KV.get("oauth:state:"+state);if(!raw)return new Response("Invalid or expired OAuth state",{status:400});
  const saved=JSON.parse(raw) as {oauthReqInfo:AuthRequest;codeVerifier:string};
  const redirectUri=new URL("/callback",request.url).href;
  const base={code,grant_type:"authorization_code",redirect_uri:redirectUri,code_verifier:saved.codeVerifier};
  // Cloudflare Access permits PKCE without a client secret when the SaaS app enables it.
  // Try the public-client PKCE exchange first; retain secret-based fallbacks for compatibility.
  let tr=await fetch(env.ACCESS_TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...base,client_id:env.ACCESS_CLIENT_ID}).toString()});
  if(!tr.ok){
    tr=await fetch(env.ACCESS_TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...base,client_id:env.ACCESS_CLIENT_ID,client_secret:env.ACCESS_CLIENT_SECRET}).toString()});
  }
  if(!tr.ok){
    const basic=btoa(env.ACCESS_CLIENT_ID+":"+env.ACCESS_CLIENT_SECRET);
    tr=await fetch(env.ACCESS_TOKEN_URL,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","authorization":"Basic "+basic},body:new URLSearchParams(base).toString()});
  }
  if(!tr.ok){
    let detail="upstream_token_exchange_failed";
    try{const t=await tr.text();const j=JSON.parse(t);detail=String(j.error_description||j.error||detail).slice(0,300);}catch{}
    return new Response("Access token exchange failed: "+detail,{status:502});
  }
  const tokens=await tr.json() as any;if(!tokens.id_token)return new Response("Missing Access ID token",{status:502});
  let claims:any;
  try{claims=await verifyIdToken(env,tokens.id_token);}
  catch(err:any){
    // Authentication failures must not escape as Worker exceptions (1101).
    // Return a controlled 401 and keep the exact internal reason out of the response.
    console.error("ATLAS_OAUTH_ID_TOKEN_REJECTED",String(err?.message||err));
    return new Response("Invalid Access ID token",{status:401,headers:{"cache-control":"no-store"}});
  }
  await env.OAUTH_KV.delete("oauth:state:"+state);
  const {redirectTo}=await env.OAUTH_PROVIDER.completeAuthorization({metadata:{label:String(claims.name||claims.email||claims.sub||"ATLAS user")},props:{email:String(claims.email||""),name:String(claims.name||claims.email||"ATLAS user"),login:String(claims.sub||"")},request:saved.oauthReqInfo,scope:saved.oauthReqInfo.scope,userId:String(claims.sub||claims.email||"atlas-user")});
  return Response.redirect(redirectTo,302);
 }
 return new Response("Not Found",{status:404});
}