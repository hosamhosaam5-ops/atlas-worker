// RISK ENGINE — ported verbatim (logic) from backup node "Risk Engine".
// Per-action risk classification + blocking verdict + duplicate-request guard.
export function runRiskEngine(item) {
  const ALLOWED = ['calculator', 'datetime', 'memory_query', 'web_research'];
  const actions = Array.isArray(item.actions) ? item.actions : [];
  const actionRisks = actions.map(a => ({ id: a.id, tool: a.tool, risk: ALLOWED.includes(a.tool) ? 'TOOL_REQUIRED' : 'UNKNOWN' }));
  const reply = (item.reply || '').toUpperCase();
  const isHighRisk = reply.includes('BLOCKED') || reply.includes('WAITING_FOR_FOUNDER');
  const anyUnknown = actionRisks.some(r => r.risk === 'UNKNOWN');
  const hasActions = actions.length > 0;
  const blocked = anyUnknown || (isHighRisk && !hasActions);
  const baseRisk = (blocked && isHighRisk) ? 'HIGH_RISK' : (hasActions ? 'TOOL_REQUIRED' : 'SAFE');
  const outActions = blocked ? [] : actions;
  const dupReq = item.duplicate_request === true && typeof item.prior_final_reply === 'string' && item.prior_final_reply.trim().length > 0;
  const finalActions = dupReq ? [] : outActions;
  return { ...item, actions: finalActions, risk: baseRisk, actionRisks, blocked, skip_duplicate_request: dupReq, has_tool: finalActions.length > 0, has_web_research: finalActions.some(a => a.tool === 'web_research') };
}
