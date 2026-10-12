// Deterministic presentation for live web-research tool results.
// This intentionally avoids a second LLM call when the requested work is only research:
// returned titles, URLs, and snippets already form a complete, source-attributed answer.
export function formatResearchReply(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const entries = [];
  for (const [index, result] of results.entries()) {
    if (!result || result.tool !== 'web_research') return null;
    const body = String(result.result || '').trim();
    if (result.status === 'SUCCEEDED') {
      if (!body) return null;
      entries.push(body);
      continue;
    }
    const status = String(result.status || 'UNKNOWN');
    const code = String(result.error_code || 'NO_ERROR_CODE');
    entries.push(
      'تعذر إكمال نتيجة البحث رقم ' + (index + 1) +
      ' (الحالة: ' + status + '؛ الرمز: ' + code + ').\n' +
      (body || 'لم يُرجع مزود البحث تفاصيل إضافية.')
    );
  }
  if (!entries.length) return null;
  return 'نتائج البحث المباشر (العناوين والروابط والمقتطفات من مزود البحث):\n\n' + entries.join('\n\n');
}


// Deterministic intent extraction is intentionally narrow: bypass AI1 only when the
// founder explicitly names web_research and gives an actual search command.
export function extractExplicitWebResearchQuery(message) {
  const text = String(message || '').trim();
  if (!/\bweb_research\b/i.test(text)) return null;
  const patterns = [
    /(?:ابحث|البحث)\s+(?:مباشرة\s+)?(?:عبر|باستخدام|بواسطة)\s+web_research\s+(?:عن|حول)\s+([^.!؟?\n]+)/i,
    /(?:استخدم|شغّل|نفّذ|نفذ)\s+(?:أداة\s+)?web_research\s+(?:للبحث|ابحث)\s+(?:عن|حول)\s+([^.!؟?\n]+)/i,
    /\b(?:use|run|call)\s+web_research\s+(?:to\s+search\s+(?:for|about)|for|about)\s+([^.!?\n]+)/i,
    /\bweb_research\s*[:：]\s*([^.!?\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const query = String(match?.[1] || '').trim().replace(/[.!؟?]+$/g, '').trim();
    if (query.length >= 3) return query.slice(0, 1000);
  }
  return null;
}
