// ATLAS Trust Boundary + autonomy policy helpers.
// External content is data, never executable instruction. High-risk actions are fail-closed.
const SECRET_KEYS=/token|secret|password|private.?key|seed|credential/i;
const INSTRUCTION_KEYS=/system|developer|tool_call|function_call|execute|shell|command/i;

export function sanitizeExternalInput(input){
  const walk=(v)=>{
    if(Array.isArray(v)) return v.map(walk);
    if(v && typeof v==='object'){
      const o={};
      for(const [k,val] of Object.entries(v)){
        if(SECRET_KEYS.test(k)) o[k]='[REDACTED]';
        else if(INSTRUCTION_KEYS.test(k)) o[k]=typeof val==='string'?'[UNTRUSTED_INSTRUCTION_DATA]':walk(val);
        else o[k]=walk(val);
      }
      return o;
    }
    if(typeof v==='string') return v.slice(0,20000);
    return v;
  };
  return {trusted:false,data:walk(input),boundary:'EXTERNAL_DATA'};
}

export function authorizeAction(action,{paid=false,sensitive=false,outboundSpend=false,majorStrategy=false}={}){
  if(outboundSpend) return {allowed:false,reason:'FOUNDER_FINANCIAL_GATE'};
  if(majorStrategy) return {allowed:false,reason:'FOUNDER_STRATEGY_GATE'};
  if(sensitive) return {allowed:false,reason:'SENSITIVE_DATA_GATE'};
  if(paid) return {allowed:true,reason:'INBOUND_PAID_ORDER_ALLOWED'};
  return {allowed:true,reason:'AUTONOMOUS_LOW_RISK'};
}

export function validateMarketplaceLead(lead){
  if(!lead || typeof lead!=='object') return {ok:false,reason:'INVALID_LEAD'};
  const text=String(lead.description||lead.title||'').trim();
  if(!text) return {ok:false,reason:'EMPTY_REQUEST'};
  const blocked=/credential|private key|malware|ransomware|weapon|fraud|phishing|stolen data/i.test(text);
  if(blocked) return {ok:false,reason:'HIGH_RISK_REQUEST'};
  return {ok:true,score:Math.min(1,text.length/1000),untrusted:true};
}
