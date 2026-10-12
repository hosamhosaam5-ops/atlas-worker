import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResearchReply, extractExplicitWebResearchQuery } from '../src/ceo/research-reply.js';

test('formats all successful web research results without truncating URLs or snippets', () => {
  const firstSnippet = 'A'.repeat(650);
  const results = [
    {
      tool: 'web_research',
      status: 'SUCCEEDED',
      error_code: '',
      result: 'نتائج البحث عن "Tavily API":\n- Tavily API reference | https://docs.tavily.com/documentation/api-reference/introduction: ' + firstSnippet,
    },
    {
      tool: 'web_research',
      status: 'SUCCEEDED',
      error_code: '',
      result: '- Tavily search endpoint | https://docs.tavily.com/documentation/api-reference/endpoint/search: official search endpoint docs',
    },
  ];

  const reply = formatResearchReply(results);
  assert.ok(reply.startsWith('نتائج البحث المباشر'));
  assert.ok(reply.includes('https://docs.tavily.com/documentation/api-reference/introduction'));
  assert.ok(reply.includes('https://docs.tavily.com/documentation/api-reference/endpoint/search'));
  assert.ok(reply.includes(firstSnippet));
});

test('reports failed web research explicitly without claiming success', () => {
  const reply = formatResearchReply([{
    tool: 'web_research',
    status: 'FAILED',
    error_code: 'ERR_UPSTREAM_503',
    result: 'خطأ: مزود البحث غير متاح',
  }]);

  assert.ok(reply.includes('الحالة: FAILED'));
  assert.ok(reply.includes('ERR_UPSTREAM_503'));
  assert.ok(reply.includes('خطأ: مزود البحث غير متاح'));
});

test('returns null if results are empty or mixed with non-research tools', () => {
  assert.equal(formatResearchReply([]), null);
  assert.equal(formatResearchReply([{ tool: 'calculator', status: 'SUCCEEDED', result: '2' }]), null);
});


test('extracts an explicit Arabic web_research request without requiring AI1', () => {
  const query = extractExplicitWebResearchQuery(
    'اختبار: ابحث عبر web_research عن وثائق Tavily الرسمية لواجهة POST /search. أعد الروابط دون اختلاق.'
  );
  assert.equal(query, 'وثائق Tavily الرسمية لواجهة POST /search');
});

test('extracts explicit alternative wording and English tool requests', () => {
  assert.equal(
    extractExplicitWebResearchQuery('استخدم أداة web_research للبحث عن Tavily API search docs.'),
    'Tavily API search docs'
  );
  assert.equal(
    extractExplicitWebResearchQuery('Use web_research to search for official Tavily docs.'),
    'official Tavily docs'
  );
});

test('does not bypass AI1 for vague mentions of web_research', () => {
  assert.equal(extractExplicitWebResearchQuery('اشرح لي ما هي أداة web_research.'), null);
  assert.equal(extractExplicitWebResearchQuery('أريد مناقشة البحث على الويب لاحقاً.'), null);
});
