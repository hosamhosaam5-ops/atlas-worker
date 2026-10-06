import test from 'node:test';
import assert from 'node:assert/strict';
import { runCeoEngine } from '../src/ceo/engine.js';
import { parseAndAuthorize } from '../src/bridges/chatgpt.js';

const waitingTask = {
  entity_type: 'task',
  entity_id: 'task_approve_1',
  status: 'WAITING_APPROVAL',
  task: {
    task_id: 'task_approve_1',
    goal_id: 'goal_1',
    title: 'send payment',
    description: 'send payment',
    status: 'WAITING_APPROVAL',
    attempt_count: 0,
    max_attempts: 3,
    created_at: '2026-10-06T00:00:00.000Z',
    updated_at: '2026-10-06T00:00:00.000Z',
    last_progress_at: '2026-10-06T00:00:00.000Z',
  },
};

function run(message, source='telegram', founderId='5246182877', founderChatId='5246182877') {
  return runCeoEngine({
    request_id: 'req_test_' + Math.random().toString(36).slice(2),
    correlation_id: 'corr_test',
    founder_message: message,
    chat_id: founderChatId,
    founder_id: founderId,
    founder_chat_id: founderChatId,
    approval_source: source,
    reply: '',
    state_rows: [waitingTask],
  }, { now: '2026-10-06T23:30:00.000Z', max_steps: 30 });
}

test('E9: verified Telegram founder explicit task approval grants only target task', () => {
  const out = run('أوافق task_approve_1');
  const row = out.state_rows.find(r => r.entity_type === 'task' && r.entity_id === 'task_approve_1');
  assert.equal(row?.status, 'READY');
  assert.ok(out.events.some(e => e.type === 'APPROVAL_GRANTED' && e.entity_id === 'task_approve_1'));
});

test('E9: bridge approval never changes approval state', () => {
  const out = run('أوافق task_approve_1', 'bridge');
  assert.ok(!out.state_rows.some(r => r.entity_type === 'task' && r.status === 'READY'));
  assert.ok(out.events.some(e => e.type === 'APPROVAL_REJECTED'));
});

test('E9: wrong Telegram founder id cannot approve', () => {
  const out = run('أوافق task_approve_1', 'telegram', '999999', '5246182877');
  assert.ok(!out.state_rows.some(r => r.entity_type === 'task' && r.status === 'READY'));
  assert.ok(out.events.some(e => e.type === 'APPROVAL_REJECTED'));
});

for (const phrase of ['غير موافق', 'لا أوافق', 'disapprove']) {
  test('E9: negative phrase is not approval — ' + phrase, () => {
    const out = run(phrase);
    assert.ok(!out.state_rows.some(r => r.entity_type === 'task' && r.status === 'READY'));
    assert.ok(out.events.some(e => e.type === 'APPROVAL_REJECTED'));
  });
}

test('E9: approval without target id cannot approve collectively', () => {
  const out = run('أوافق');
  assert.ok(!out.state_rows.some(r => r.entity_type === 'task' && r.status === 'READY'));
  assert.ok(out.events.some(e => e.type === 'APPROVAL_REJECTED' && String(e.detail).includes('collective')));
});

test('E6: bridge whitelist no longer exposes state or memory writes', () => {
  assert.equal(parseAndAuthorize({ operation: 'write_state' }).whitelisted, false);
  assert.equal(parseAndAuthorize({ operation: 'write_memory' }).whitelisted, false);
  assert.equal(parseAndAuthorize({ operation: 'execute_ceo' }).whitelisted, true);
});
