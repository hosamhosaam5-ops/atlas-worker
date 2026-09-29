// MEMORY FORMATTER — ported from backup node "Format Memory".
// Memory is global, not per-item. Dedupe + hard char budget so the system prompt
// can never exceed the model context window.
const MEMORY_BUDGET_CHARS = 24000;
const PREFERRED_CATS = ['decision', 'goal', 'preference', 'task', 'fact'];

export function formatMemory(memRows) {
  const canonFm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const seen = new Set();
  const rows = (memRows || []).filter(r => r && r.content).filter(r => {
    const k = canonFm(r.content);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rowLen = r => String(r.content || '').length + String(r.category || 'general').length + 6;
  const preferred = rows.filter(r => PREFERRED_CATS.indexOf(String(r.category || '').toLowerCase()) !== -1);
  const rest = rows.filter(r => PREFERRED_CATS.indexOf(String(r.category || '').toLowerCase()) === -1);
  const kept = [];
  let used = 0;
  let truncated = false;
  for (const r of preferred.concat(rest)) {
    const len = rowLen(r);
    if (used + len > MEMORY_BUDGET_CHARS) { truncated = true; continue; }
    kept.push(r);
    used += len;
  }
  const memoryText = kept.length ? kept.map(r => '- [' + (r.category || 'general') + '] ' + r.content).join('\n') : '';
  return {
    memory_text: memoryText,
    memory_count: kept.length,
    memory_context_chars: memoryText.length,
    memory_truncated: truncated || kept.length < rows.length,
  };
}

// Memory query tool implementation — ported from backup node "Action Executor" (memq).
export function memoryQuery(q, memRows) {
  q = String(q || '').trim().toLowerCase();
  const rows = (memRows || []).filter(j => j && j.content);
  if (!q) return 'خطأ: استعلام فارغ.';
  const terms = q.split(' ').filter(t => t.length > 1);
  const m = rows.filter(r => terms.some(t => String(r.content).toLowerCase().includes(t))).slice(0, 5);
  return m.length
    ? 'نتائج البحث في الذاكرة عن "' + q + '":\n' + m.map(r => '- [' + (r.category || 'general') + '] ' + r.content).join('\n')
    : 'لا توجد نتائج مطابقة في الذاكرة عن: ' + q;
}
