import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const b64url=(b:Uint8Array)=>btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const decode=(s:string)=>{s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";return atob(s);};
async function makePkce(){const v=b64url(crypto.getRandomValues(new Uint8Array(32)));const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return {codeVerifier:v,codeChallenge:b64url(new Uint8Array(d))};}
async function verifyIdToken(env:OAuthEnv,token:string){
 const [h,p,s]=token.split(".");if(!h||!p||!s)throw new Error("INVALID_ID_TOKEN");
 const header=JSON.parse(decode(h));const claims=JSON.parse(decode(p));
 const jwks=await (await fetch(env.ACCESS_JWKS_URL)).json() as any;const jwk=jwks.keys?.find((k:any)=>k.kid===header.kid);if(!jwk)throw new Error("UNKNOWN_ID_TOKEN_KEY");
 const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
 const sig=Uint8Array.from(decode(s),c=>c.charCodeAt(0));
 if(!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,sig,new TextEncoder().encode(h+"."+p))))throw new Error("INVALID_ID_TOKEN_SIGNATURE");
 if(claims.exp&&claims.exp<Math.floor(Date.now()/1000))throw new Error("EXPIRED_ID_TOKEN");
 return claims;
}
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
  const claims=await verifyIdToken(env,tokens.id_token);
  await env.OAUTH_KV.delete("oauth:state:"+state);
  const {redirectTo}=await env.OAUTH_PROVIDER.completeAuthorization({metadata:{label:String(claims.name||claims.email||claims.sub||"ATLAS user")},props:{email:String(claims.email||""),name:String(claims.name||claims.email||"ATLAS user"),login:String(claims.sub||"")},request:saved.oauthReqInfo,scope:saved.oauthReqInfo.scope,userId:String(claims.sub||claims.email||"atlas-user")});
  return Response.redirect(redirectTo,302);
 }
 return new Response("Not Found",{status:404});
}