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
