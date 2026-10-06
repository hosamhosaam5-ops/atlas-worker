// CEO ENGINE v1.0 — deterministic planning layer.
// Ported verbatim (logic) from the actual backup: my-workflow.workflow.ts, node "CEO Engine".
// No network, no randomness, no LLM calls. Dates injectable via opts.now for determinism.

function hashCeo(s) {
  let h = 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
function nowIso(opts) { return (opts && opts.now) || new Date().toISOString(); }
function addHours(iso, h) { return new Date(new Date(iso).getTime() + h * 3600 * 1000).toISOString(); }

// Policy
var PRIORITY_W = { CRITICAL: 1.0, HIGH: 0.8, MEDIUM: 0.5, LOW: 0.2 };
var APPROVAL_PATTERNS = [
  { key: 'EXTERNAL_FINANCIAL', re: /(ادفع|ادفعي|شراء|اشتري|اشترك|اشتراك|مبلغ|دولار|ريال|payment|pay |buy |purchase|subscribe|invoice)/i },
  { key: 'DESTRUCTIVE', re: /(احذف|امسح|delete|remove|destroy|wipe)/i },
  { key: 'EXTERNAL_PUBLISH', re: /(انشر|publish|post |tweet|launch|أطلق|اطلاق)/i },
  { key: 'CUSTOMER_MESSAGE', re: /(أرسل للعميل|راسل العميل|message customer|email customer|whatsapp)/i },
  { key: 'CREDENTIAL_CHANGE', re: /(credential|api key|password|secret|token)/i },
  { key: 'DEPLOYMENT', re: /(deploy|deployment|نشر إنتاج|production deploy)/i },
];
var GOAL_STATUSES = ['PROPOSED', 'APPROVED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED'];
var TASK_STATUSES = ['PLANNED', 'READY', 'RUNNING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER', 'WAITING_APPROVAL', 'ABANDONED'];
var FU_STATUSES = ['FOLLOW_UP_REQUIRED', 'FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_RUNNING', 'FOLLOW_UP_COMPLETED', 'FOLLOW_UP_FAILED', 'FOLLOW_UP_CANCELLED'];

function hydrate(stateRows) {
  var goals = {}, tasks = {}, decisions = {}, followups = {}, learnings = {}, plans = {}, approvals = {};
  (stateRows || []).forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    var t = r.entity_type;
    var pack = function (d) {
      d = d || {};
      if (d.status === undefined && r.status !== undefined) d.status = r.status;
      if (d.progress === undefined && r.progress !== undefined) d.progress = r.progress;
      return d;
    };
    if (t === 'goal' && r.goal) goals[r.entity_id] = { row: r, data: pack(r.goal) };
    else if (t === 'task' && r.task) tasks[r.entity_id] = { row: r, data: pack(r.task) };
    else if (t === 'decision' && r.decision) decisions[r.entity_id] = { row: r, data: pack(r.decision) };
    else if (t === 'followup' && r.followup) followups[r.entity_id] = { row: r, data: pack(r.followup) };
    else if (t === 'learning' && r.learning) learnings[r.entity_id] = { row: r, data: pack(r.learning) };
    else if (t === 'plan' && r.plan) plans[r.entity_id] = { row: r, data: pack(r.plan) };
    else if (t === 'approval' && r.approval) approvals[r.entity_id] = { row: r, data: pack(r.approval) };
  });
  return { goals: goals, tasks: tasks, decisions: decisions, followups: followups, learnings: learnings, plans: plans, approvals: approvals };
}

function goalScore(g) {
  var pw = PRIORITY_W[String(g.priority || 'MEDIUM').toUpperCase()] != null ? PRIORITY_W[String(g.priority || 'MEDIUM').toUpperCase()] : 0.5;
  var days = 30;
  if (g.deadline) {
    var ms = new Date(g.deadline).getTime() - Date.now();
    days = Math.max(0, ms / 86400000);
  }
  var dl = 1 / (1 + days / 7);
  var dep = num(g.dependency_blocking, 0);
  var imp = num(g.business_impact, 0.5);
  var rsk = num(g.risk, 0);
  var eff = num(g.effort, 0.5);
  var effInv = 1 / (1 + eff);
  var score = 0.30 * pw + 0.20 * dl + 0.15 * dep + 0.15 * imp - 0.10 * rsk + 0.10 * effInv;
  return Math.round(score * 10000) / 10000;
}

function approvalFor(text) {
  var t = String(text || '');
  for (var i = 0; i < APPROVAL_PATTERNS.length; i++) {
    if (APPROVAL_PATTERNS[i].re.test(t)) return APPROVAL_PATTERNS[i].key;
  }
  return null;
}

var TRUSTED_CATEGORIES = ['fact', 'decision', 'goal', 'preference', 'task'];
var REJECT_CATEGORIES = ['option', 'unknown', 'conflict'];
function canon(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!؟?،,؛:\s]+$/, '').trim(); }
function learnFromMemories(memories, learnings, requestId, now) {
  var rows = [];
  var trusted = [];
  var seenCanon = {};
  Object.keys(learnings).forEach(function (id) {
    var l = learnings[id].data;
    var key = canon(l.observation);
    if (key) seenCanon[key] = id;
    if (l.validated === true && String(l.status) === 'VALIDATED') trusted.push({ observation: l.observation, source: l.source, validated: true });
  });
  (memories || []).forEach(function (m) {
    if (!m || typeof m.content !== 'string') return;
    var cat = String(m.category || 'fact').toLowerCase();
    if (REJECT_CATEGORIES.indexOf(cat) !== -1) return;
    if (TRUSTED_CATEGORIES.indexOf(cat) === -1) cat = 'fact';
    var c = canon(m.content);
    if (!c) return;
    var existingId = seenCanon[c];
    if (existingId) {
      var existing = learnings[existingId].data;
      if (existing.validated === true && String(existing.status) === 'VALIDATED') {
        return;
      }
    }
    var clashId = null;
    var kv = c.match(/^(.+?)(?: هو | هي | = |: | is )(.+)$/);
    if (kv) {
      var subj = kv[1].trim(), val = kv[2].trim();
      Object.keys(learnings).forEach(function (id) {
        var l = learnings[id].data;
        var ek = canon(l.observation).match(/^(.+?)(?: هو | هي | = |: | is )(.+)$/);
        if (ek && ek[1].trim() === subj && ek[2].trim() !== val) clashId = id;
      });
    }
    var status = clashId ? 'CONFLICT' : 'PROPOSED';
    var validated = false;
    var lid = 'lrn_' + hashCeo(requestId + '|' + c);
    rows.push({
      entity_type: 'learning',
      entity_id: lid,
      correlation_id: requestId,
      status: status,
      created_at: now,
      updated_at: now,
      learning: {
        learning_id: lid,
        source: 'ai1_memory',
        event_type: 'memory_proposal',
        observation: clamp(m.content, 400),
        result: null,
        confidence: 0.5,
        validated: validated,
        status: status,
        conflicting_with: clashId || null,
        created_at: now,
      },
    });
    seenCanon[c] = lid;
  });
  return { rows: rows, trusted_memory: trusted.slice(0, 10) };
}

export function runCeoEngine(input, opts) {
  opts = opts || {};
  var cfg = Object.assign({
    max_active_goals: 5,
    max_steps: 30,
    max_actions_per_cycle: 5,
    max_retries_per_task: 3,
    max_events: 30,
    max_depth: 2,
    max_objectives_per_plan: 4,
    stale_running_minutes: 120,
    followup_delay_hours: 24,
    max_followups_per_goal: 2,
    cycle_deadline_seconds: 300,
    w_goal_priority: 0.30,
    w_deadline: 0.20,
    w_dependency: 0.15,
    w_impact: 0.15,
    w_risk: 0.10,
    w_effort: 0.10,
  }, opts.config || {});
  var now = nowIso(opts);
  var requestId = String(input.request_id || 'req_unknown');
  var corr = String(input.correlation_id || 'corr_unknown');
  var founderMessage = String(input.founder_message || '');
  var chatId = String(input.chat_id || '');
  var replyRaw = String(input.reply || '');
  var errors = [];
  var outRows = [];
  var events = [];
  var decisionsOut = [];
  var steps = 0;
  function pushEvent(type, id, status, detail) {
    if (events.length >= cfg.max_events) return;
    events.push({ event_id: 'evt_' + hashCeo(requestId + '|' + type + '|' + id + '|' + events.length), correlation_id: corr, request_id: requestId, timestamp: now, type: type, entity_id: id || null, status: status || 'OK', detail: clamp(detail, 200) });
  }
  function emitRow(r) { outRows.push(r); }
  function emitDecision(d) {
    var did = 'dec_' + hashCeo(requestId + '|' + d.question + '|' + decisionsOut.length);
    var row = {
      entity_type: 'decision',
      entity_id: did,
      correlation_id: corr,
      status: d.approved ? 'APPROVED' : (d.requires_approval ? 'PENDING' : 'DECIDED'),
      created_at: now,
      updated_at: now,
      decision: {
        decision_id: did,
        goal_id: d.goal_id || null,
        task_id: d.task_id || null,
        question: clamp(d.question, 300),
        options: d.options || [],
        selected_option: d.selected_option || null,
        reason: clamp(d.reason, 300),
        evidence: clamp(d.evidence, 300),
        confidence: num(d.confidence, 0.5),
        risk: d.risk || 'LOW',
        requires_approval: !!d.requires_approval,
        approved: !!d.approved,
        created_at: now,
      },
    };
    decisionsOut.push(row.decision);
    emitRow(row);
    return row.decision;
  }

  var S = hydrate(input.state_rows);
  var rowIndex = {};
  ['goals', 'tasks', 'decisions', 'followups', 'learnings', 'plans', 'approvals'].forEach(function (k) {
    Object.keys(S[k]).forEach(function (id) { rowIndex[id] = S[k][id].row; });
  });
  function syncRow(t, status, progress) {
    var r = rowIndex[t.task_id || t.goal_id || t.followup_id || t.decision_id || t.plan_id || t.approval_id];
    if (r) { r.status = status; if (progress !== undefined) r.progress = progress; }
  }
  var durable = {
    goals: Object.keys(S.goals).map(function (k) { return S.goals[k].data; }),
    tasks: Object.keys(S.tasks).map(function (k) { return S.tasks[k].data; }),
    decisions: Object.keys(S.decisions).map(function (k) { return S.decisions[k].data; }),
    followups: Object.keys(S.followups).map(function (k) { return S.followups[k].data; }),
    learnings: Object.keys(S.learnings).map(function (k) { return S.learnings[k].data; }),
    plans: Object.keys(S.plans).map(function (k) { return S.plans[k].data; }),
    approvals: Object.keys(S.approvals).map(function (k) { return S.approvals[k].data; }),
  };

  // 1. Goal Manager
  var goalMatch = founderMessage.match(/(?:^|\s)(?:هدف(?:\s+جديد)?|هدفي|الهدف)\s*[:：]?\s*(.+)/);
  if (goalMatch && goalMatch[1]) {
    var title = clamp(goalMatch[1].trim(), 120);
    if (title) {
      var gid = 'goal_' + hashCeo(chatId + '|' + title);
      if (S.goals[gid]) {
        emitDecision({ goal_id: gid, question: 'Goal already exists', selected_option: 'DUPLICATE_SKIP', reason: 'deterministic goal_id already present', confidence: 1, risk: 'LOW' });
        pushEvent('GOAL_DUPLICATE', gid, 'SKIPPED', title);
      } else {
        var approvalKey = approvalFor(title);
        var gStatus = approvalKey ? 'PROPOSED' : 'APPROVED';
        var goal = {
          goal_id: gid,
          title: title,
          description: title,
          status: gStatus,
          priority: 'MEDIUM',
          created_at: now,
          deadline: null,
          success_criteria: [],
          constraints: [],
          approval_required: !!approvalKey,
          approval_reason: approvalKey || null,
          owner: 'founder',
          parent_goal: null,
          progress: 0,
          last_updated_at: now,
        };
        durable.goals.push(goal);
        emitRow({ entity_type: 'goal', entity_id: gid, correlation_id: corr, status: gStatus, progress: 0, created_at: now, updated_at: now, goal: goal });
        pushEvent('GOAL_CREATED', gid, gStatus, title);
        if (approvalKey) {
          emitRow({
            entity_type: 'approval',
            entity_id: 'appr_' + hashCeo(gid + '|' + approvalKey),
            correlation_id: corr,
            status: 'PENDING',
            created_at: now,
            updated_at: now,
            approval: { approval_id: 'appr_' + hashCeo(gid + '|' + approvalKey), entity_type: 'goal', entity_id: gid, reason: approvalKey, status: 'PENDING', created_at: now },
          });
          pushEvent('APPROVAL_REQUESTED', gid, 'PENDING', approvalKey);
        }
      }
    }
    steps++;
  }

  // 2. Planner
  var planMatch = founderMessage.match(/(?:خطط|خططي|plan)\s+(?:للهدف|ل)?\s*[:：]?\s*(.+)/i);
  function planForGoal(goal) {
    if (!goal) return;
    var planId = 'plan_' + hashCeo(goal.goal_id + '|' + goal.title);
    if (S.plans[planId]) {
      pushEvent('PLAN_DUPLICATE', planId, 'SKIPPED', goal.title);
      return;
    }
    var objectives = [
      'تحديد نطاق العمل ومعايير النجاح',
      'بحث السوق والمنافسين والطلب',
      'بناء نموذج أولي / خطة تنفيذ MVP',
      'مراجعة المؤسس والموافقة قبل أي إطلاق خارجي',
    ].slice(0, cfg.max_objectives_per_plan);
    var plan = { plan_id: planId, goal_id: goal.goal_id, objectives: objectives, depth: 1, stop_condition: 'all tasks SUCCEEDED or goal abandoned', created_at: now, status: 'PLANNED' };
    durable.plans.push(plan);
    emitRow({ entity_type: 'plan', entity_id: planId, correlation_id: corr, status: 'PLANNED', created_at: now, updated_at: now, plan: plan });
    pushEvent('PLAN_CREATED', planId, 'PLANNED', goal.title);
    objectives.forEach(function (obj, i) {
      var tid = 'task_' + hashCeo(goal.goal_id + '|' + obj);
      if (S.tasks[tid]) { pushEvent('TASK_DUPLICATE', tid, 'SKIPPED', obj); return; }
      var task = {
        task_id: tid,
        goal_id: goal.goal_id,
        title: obj,
        description: obj,
        status: i === 0 ? 'READY' : 'BLOCKED',
        priority: goal.priority || 'MEDIUM',
        depends_on: i === 0 ? planId : 'task_' + hashCeo(goal.goal_id + '|' + objectives[i - 1]),
        attempt_count: 0,
        max_attempts: cfg.max_retries_per_task,
        deadline: null,
        result: null,
        error: null,
        created_at: now,
        updated_at: now,
        last_progress_at: now,
      };
      durable.tasks.push(task);
      emitRow({ entity_type: 'task', entity_id: tid, correlation_id: corr, status: task.status, progress: 0, created_at: now, updated_at: now, task: task });
      pushEvent('TASK_CREATED', tid, task.status, obj);
    });
    steps++;
  }
  if (planMatch && planMatch[1]) {
    var pTitle = clamp(planMatch[1].trim(), 120);
    var target = durable.goals.filter(function (g) { return g.title === pTitle || g.goal_id === 'goal_' + hashCeo(chatId + '|' + pTitle); })[0];
    if (!target) {
      var gid2 = 'goal_' + hashCeo(chatId + '|' + pTitle);
      if (!S.goals[gid2]) {
        var g2 = { goal_id: gid2, title: pTitle, description: pTitle, status: 'APPROVED', priority: 'MEDIUM', created_at: now, deadline: null, success_criteria: [], constraints: [], approval_required: false, owner: 'founder', parent_goal: null, progress: 0, last_updated_at: now };
        durable.goals.push(g2);
        emitRow({ entity_type: 'goal', entity_id: gid2, correlation_id: corr, status: 'APPROVED', progress: 0, created_at: now, updated_at: now, goal: g2 });
        pushEvent('GOAL_CREATED', gid2, 'APPROVED', pTitle);
        target = g2;
      }
    }
    planForGoal(target);
  }

  // 3. Task Manager
  var staleCutoff = new Date(new Date(now).getTime() - cfg.stale_running_minutes * 60000).toISOString();
  durable.tasks.forEach(function (t) {
    if (t.status === 'RUNNING' && t.last_progress_at && t.last_progress_at < staleCutoff) {
      t.status = 'ABANDONED'; syncRow(t, 'ABANDONED');
      t.abandoned_at = now;
      t.updated_at = now;
      emitRow({ entity_type: 'task', entity_id: t.task_id, correlation_id: corr, status: 'ABANDONED', progress: num(t.progress, 0), created_at: t.created_at, updated_at: now, task: t });
      pushEvent('TASK_ABANDONED', t.task_id, 'ABANDONED', 'stale RUNNING exceeded ' + cfg.stale_running_minutes + 'm');
      return;
    }
    if (t.status === 'FAILED' && num(t.attempt_count, 0) >= num(t.max_attempts, cfg.max_retries_per_task)) {
      t.status = 'DEAD_LETTER'; syncRow(t, 'DEAD_LETTER');
      t.dead_letter_at = now;
      t.updated_at = now;
      emitRow({ entity_type: 'task', entity_id: t.task_id, correlation_id: corr, status: 'DEAD_LETTER', progress: num(t.progress, 0), created_at: t.created_at, updated_at: now, task: t });
      pushEvent('TASK_DEAD_LETTER', t.task_id, 'DEAD_LETTER', 'max attempts ' + t.attempt_count + '/' + t.max_attempts);
      emitDecision({ goal_id: t.goal_id, task_id: t.task_id, question: 'Task exceeded max attempts', selected_option: 'DEAD_LETTER', reason: 'retry budget exhausted', confidence: 1, risk: 'MEDIUM' });
      return;
    }
    if (t.status === 'FAILED') {
      var canRetry = num(t.attempt_count, 0) < num(t.max_attempts, cfg.max_retries_per_task);
      emitDecision({ goal_id: t.goal_id, task_id: t.task_id, question: 'Task failed — choose recovery', options: ['RETRY', 'REPLAN', 'ESCALATE', 'DEAD_LETTER'], selected_option: canRetry ? 'RETRY' : 'REPLAN', reason: 'attempt_count=' + t.attempt_count + ' max=' + t.max_attempts, confidence: 0.8, risk: 'LOW' });
      if (canRetry) {
        t.status = 'READY'; syncRow(t, 'READY');
        t.updated_at = now;
        emitRow({ entity_type: 'task', entity_id: t.task_id, correlation_id: corr, status: 'READY', progress: num(t.progress, 0), created_at: t.created_at, updated_at: now, task: t });
        pushEvent('TASK_RETRY_SCHEDULED', t.task_id, 'READY', 'bounded retry');
      } else {
        pushEvent('TASK_REPLAN_NEEDED', t.task_id, 'FAILED', 'replan decision recorded');
      }
      return;
    }
    if (t.status === 'READY' && t.depends_on) {
      var depId = t.depends_on;
      var depTask = durable.tasks.filter(function (x) { return x.task_id === depId; })[0];
      var depPlan = durable.plans.filter(function (x) { return x.plan_id === depId; })[0];
      var depDone = (depTask && depTask.status === 'SUCCEEDED') || (depPlan && depPlan.status === 'PLANNED');
      if (!depDone) {
        t.status = 'BLOCKED'; syncRow(t, 'BLOCKED');
        t.updated_at = now;
        emitRow({ entity_type: 'task', entity_id: t.task_id, correlation_id: corr, status: 'BLOCKED', progress: 0, created_at: t.created_at, updated_at: now, task: t });
        pushEvent('TASK_BLOCKED', t.task_id, 'BLOCKED', 'dependency ' + depId + ' not complete');
        return;
      }
    }
  });

  // 4. Prioritizer
  durable.goals.forEach(function (g) {
    g.dependency_blocking = durable.tasks.filter(function (t) { return t.goal_id === g.goal_id && (t.status === 'BLOCKED' || t.status === 'FAILED'); }).length > 0 ? 1 : 0;
    g.priority_score = goalScore(g);
  });
  var activeGoals = durable.goals
    .filter(function (g) { return ['APPROVED', 'ACTIVE', 'PAUSED'].indexOf(g.status) !== -1; })
    .sort(function (a, b) { return (b.priority_score || 0) - (a.priority_score || 0); })
    .slice(0, cfg.max_active_goals);
  var activeGoalIds = {};
  activeGoals.forEach(function (g) { activeGoalIds[g.goal_id] = true; if (g.status === 'APPROVED') { g.status = 'ACTIVE'; g.last_updated_at = now; } });

  // 5. Approval Gate
  // Approval is valid only when the request originated from the verified Telegram path
  // and the Telegram sender matches the server-side founder identity.
  var negativeApproval = /(?:غير\s+موافق|لا\s+أوافق|disapprove)/i.test(founderMessage);
  var approvalMsg = founderMessage.match(/(?:^|\s)(?:أوافق|موافق|نعم\s+أوافق|approve)\s*(?:على)?(?:\s+([a-zA-Z0-9_:-]+))?(?:\s|$)/i);
  var approvalSource = String(input.approval_source || '');
  var founderId = String(input.founder_id || '');
  var founderChatId = String(input.founder_chat_id || '');
  if (negativeApproval) {
    pushEvent('APPROVAL_REJECTED', null, 'REJECTED', 'negative approval phrase');
  } else if (approvalMsg) {
    var targetId = approvalMsg[1] ? approvalMsg[1].trim() : null;
    if (approvalSource !== 'telegram' || !founderChatId || founderId !== founderChatId) {
      pushEvent('APPROVAL_REJECTED', targetId, 'REJECTED', 'approval requires verified Telegram founder identity');
    } else if (!targetId) {
      pushEvent('APPROVAL_REJECTED', null, 'REJECTED', 'explicit task id required; collective approval is disabled');
    } else {
      var granted = false;
      durable.tasks.forEach(function (t) {
        if (t.status !== 'WAITING_APPROVAL') return;
        if (t.task_id !== targetId) return;
        t.status = 'READY'; syncRow(t, 'READY');
        t.updated_at = now;
        emitRow({ entity_type: 'task', entity_id: t.task_id, correlation_id: corr, status: 'READY', progress: 0, created_at: t.created_at, updated_at: now, task: t });
        pushEvent('APPROVAL_GRANTED', t.task_id, 'READY', 'verified Telegram founder approval');
        emitDecision({ goal_id: t.goal_id, task_id: t.task_id, question: 'Approval granted by founder', selected_option: 'APPROVE', reason: 'verified Telegram founder message', confidence: 1, risk: 'LOW', requires_approval: true, approved: true });
        granted = true;
      });
      if (!granted) pushEvent('APPROVAL_REJECTED', targetId, 'REJECTED', 'target task is not WAITING_APPROVAL');
    }
  }

  // 6. Task Execution (deterministic, no external side effects)
  var executedThisCycle = 0;
  durable.tasks.forEach(function (t) {
    if (steps >= cfg.max_steps || executedThisCycle >= cfg.max_actions_per_cycle) return;
    if (!activeGoalIds[t.goal_id]) return;
    if (t.status !== 'READY') return;
    var gate = approvalFor(t.title);
    if (gate) {
      t.status = 'WAITING_APPROVAL'; syncRow(t, 'WAITING_APPROVAL');
      t.updated_at = now;
      emitRow({ entity_type: 'task', entity_id: t.task_id, correlation_id: corr, status: 'WAITING_APPROVAL', progress: 0, created_at: t.created_at, updated_at: now, task: t });
      emitRow({
        entity_type: 'approval',
        entity_id: 'appr_' + hashCeo(t.task_id + '|' + gate),
        correlation_id: corr,
        status: 'PENDING',
        created_at: now,
        updated_at: now,
        approval: { approval_id: 'appr_' + hashCeo(t.task_id + '|' + gate), entity_type: 'task', entity_id: t.task_id, reason: gate, status: 'PENDING', created_at: now },
      });
      pushEvent('APPROVAL_REQUIRED', t.task_id, 'WAITING_APPROVAL', gate);
      return;
    }
    t.status = 'RUNNING'; syncRow(t, 'RUNNING');
    t.attempt_count = num(t.attempt_count, 0) + 1;
    t.last_progress_at = now;
    t.started_at = t.started_at || now;
    t.status = 'SUCCEEDED'; syncRow(t, 'SUCCEEDED', 100);
    t.result = 'completed internally: ' + clamp(t.title, 120);
    t.finished_at = now;
    t.updated_at = now;
    emitRow({ entity_type: 'task', entity_id: t.task_id, correlation_id: corr, status: 'SUCCEEDED', progress: 100, created_at: t.created_at, updated_at: now, task: t });
    pushEvent('TASK_SUCCEEDED', t.task_id, 'SUCCEEDED', t.title);
    executedThisCycle++;
    steps++;
  });

  // 7. Goal progress + completion guard
  durable.goals.forEach(function (g) {
    var gTasks = durable.tasks.filter(function (t) { return t.goal_id === g.goal_id; });
    if (!gTasks.length) return;
    var done = gTasks.filter(function (t) { return t.status === 'SUCCEEDED'; }).length;
    g.progress = Math.round((done / gTasks.length) * 100);
    g.last_updated_at = now;
    syncRow(g, g.status, g.progress);
    var allDone = gTasks.every(function (t) { return t.status === 'SUCCEEDED'; });
    var criteria = Array.isArray(g.success_criteria) ? g.success_criteria : [];
    if (allDone && (criteria.length === 0 || criteria.every(function (c) { return c && c.verified === true; }))) {
      if (g.status !== 'COMPLETED') {
        g.status = 'COMPLETED'; syncRow(g, 'COMPLETED', 100);
        g.completed_at = now;
        emitRow({ entity_type: 'goal', entity_id: g.goal_id, correlation_id: corr, status: 'COMPLETED', progress: 100, created_at: g.created_at, updated_at: now, goal: g });
        pushEvent('GOAL_COMPLETED', g.goal_id, 'COMPLETED', 'evidence-based completion');
      }
    } else {
      emitRow({ entity_type: 'goal', entity_id: g.goal_id, correlation_id: corr, status: g.status, progress: g.progress, created_at: g.created_at, updated_at: now, goal: g });
    }
  });

  // 8. Follow-up Manager
  durable.followups.forEach(function (f) {
    if (f.status === 'FOLLOW_UP_FAILED' && num(f.attempt_count, 0) >= num(f.max_attempts, 2)) {
      return;
    }
    var parentGoal = durable.goals.filter(function (g) { return g.goal_id === f.goal_id; })[0];
    if (parentGoal && (parentGoal.status === 'COMPLETED' || parentGoal.status === 'CANCELLED' || parentGoal.status === 'ABANDONED')) {
      if (f.status !== 'FOLLOW_UP_CANCELLED') {
        f.status = 'FOLLOW_UP_CANCELLED'; syncRow(f, 'FOLLOW_UP_CANCELLED');
        f.updated_at = now;
        emitRow({ entity_type: 'followup', entity_id: f.followup_id, correlation_id: corr, status: 'FOLLOW_UP_CANCELLED', created_at: f.created_at, updated_at: now, followup: f });
        pushEvent('FOLLOW_UP_CANCELLED', f.followup_id, 'FOLLOW_UP_CANCELLED', 'parent goal ' + parentGoal.status);
      }
      return;
    }
    if (f.status === 'FOLLOW_UP_SCHEDULED' && f.due_at && f.due_at <= now) {
      f.status = 'FOLLOW_UP_COMPLETED'; syncRow(f, 'FOLLOW_UP_COMPLETED');
      f.result = 'follow-up executed (bounded, no external side effect)';
      f.attempt_count = num(f.attempt_count, 0) + 1;
      f.updated_at = now;
      emitRow({ entity_type: 'followup', entity_id: f.followup_id, correlation_id: corr, status: 'FOLLOW_UP_COMPLETED', created_at: f.created_at, updated_at: now, followup: f });
      pushEvent('FOLLOW_UP_COMPLETED', f.followup_id, 'FOLLOW_UP_COMPLETED', f.source_task);
    }
  });
  durable.tasks.forEach(function (t) {
    if (t.status !== 'FAILED' || num(t.attempt_count, 0) >= num(t.max_attempts, cfg.max_retries_per_task)) return;
    var existingFu = durable.followups.filter(function (f) { return f.source_task === t.task_id && ['FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_RUNNING', 'FOLLOW_UP_REQUIRED'].indexOf(f.status) !== -1; })[0];
    var fuCountForGoal = durable.followups.filter(function (f) { return f.goal_id === t.goal_id; }).length;
    if (existingFu || fuCountForGoal >= cfg.max_followups_per_goal) return;
    var fid = 'fu_' + hashCeo(t.task_id + '|followup');
    var fu = { followup_id: fid, source_task: t.task_id, goal_id: t.goal_id, due_at: addHours(now, cfg.followup_delay_hours), condition: 'task ' + t.task_id + ' still FAILED', max_attempts: 2, attempt_count: 0, status: 'FOLLOW_UP_SCHEDULED', result: null, created_at: now, updated_at: now };
    durable.followups.push(fu);
    emitRow({ entity_type: 'followup', entity_id: fid, correlation_id: corr, status: 'FOLLOW_UP_SCHEDULED', created_at: now, updated_at: now, followup: fu });
    pushEvent('FOLLOW_UP_SCHEDULED', fid, 'FOLLOW_UP_SCHEDULED', t.task_id);
  });

  // 9. Learning Manager
  var aiMemories = [];
  try {
    var parsed = JSON.parse(replyRaw);
    if (parsed && Array.isArray(parsed.memories)) aiMemories = parsed.memories;
  } catch (e) { /* reply is plain text */ }
  var learn = learnFromMemories(aiMemories, S.learnings, requestId, now);
  learn.rows.forEach(emitRow);
  learn.rows.forEach(function (r) { pushEvent(r.learning.status === 'CONFLICT' ? 'LEARNING_CONFLICT' : 'LEARNING_RECORDED', r.entity_id, r.status, r.learning.observation); });

  // 10. KPI / Context
  var kpi = {
    goals_total: durable.goals.length,
    goals_active: activeGoals.length,
    goals_completed: durable.goals.filter(function (g) { return g.status === 'COMPLETED'; }).length,
    tasks_total: durable.tasks.length,
    tasks_succeeded: durable.tasks.filter(function (t) { return t.status === 'SUCCEEDED'; }).length,
    tasks_failed: durable.tasks.filter(function (t) { return t.status === 'FAILED'; }).length,
    tasks_dead_letter: durable.tasks.filter(function (t) { return t.status === 'DEAD_LETTER'; }).length,
    pending_approvals: durable.approvals.filter(function (a) { return a.status === 'PENDING'; }).length + durable.tasks.filter(function (t) { return t.status === 'WAITING_APPROVAL'; }).length,
    open_followups: durable.followups.filter(function (f) { return ['FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_RUNNING', 'FOLLOW_UP_REQUIRED'].indexOf(f.status) !== -1; }).length,
    learnings_total: durable.learnings.length + learn.rows.length,
    updated_at: now,
  };
  var context = {
    business_context: 'atlas-ceo-v1',
    active_goals: activeGoals.slice(0, 5).map(function (g) { return { goal_id: g.goal_id, title: g.title, status: g.status, priority: g.priority, priority_score: g.priority_score, progress: g.progress }; }),
    tasks_preview: durable.tasks.slice(0, 5).map(function (t) { return { task_id: t.task_id, goal_id: t.goal_id, title: t.title, status: t.status }; }),
    recent_decisions: durable.decisions.slice(-5).concat(decisionsOut.slice(-5)).slice(-5),
    kpis: kpi,
    constraints: { max_active_goals: cfg.max_active_goals, max_steps: cfg.max_steps, max_actions_per_cycle: cfg.max_actions_per_cycle },
    pending_approvals: durable.approvals.filter(function (a) { return a.status === 'PENDING'; }).map(function (a) { return a.approval_id; }).slice(0, 5),
    recent_failures: durable.tasks.filter(function (t) { return t.status === 'FAILED' || t.status === 'DEAD_LETTER'; }).slice(0, 5).map(function (t) { return t.task_id; }),
  };

  // 11. Cycle record + reply
  var cycle = {
    cycle_id: 'cyc_' + hashCeo(requestId),
    request_id: requestId,
    started_at: now,
    finished_at: now,
    steps_executed: steps,
    max_steps: cfg.max_steps,
    goal_ids: durable.goals.map(function (g) { return g.goal_id; }).slice(0, 10),
    stop_reason: steps >= cfg.max_steps ? 'MAX_STEPS' : 'COMPLETE',
    deadline_seconds: cfg.cycle_deadline_seconds,
  };
  var summaryParts = [];
  if (outRows.length) summaryParts.push('سجلات جديدة/محدثة: ' + outRows.length);
  if (kpi.goals_active) summaryParts.push('أهداف نشطة: ' + kpi.goals_active);
  if (kpi.tasks_succeeded) summaryParts.push('مهام منجزة: ' + kpi.tasks_succeeded);
  if (kpi.pending_approvals) summaryParts.push('بانتظار موافقتك: ' + kpi.pending_approvals);
  var ceoNote = summaryParts.length ? summaryParts.join(' | ') : 'لا توجد تحديثات CEO هذا الدور.';

  return {
    reply: replyRaw,
    ceo_note: ceoNote,
    ceo_context: context,
    ceo_kpi: kpi,
    decisions: decisionsOut,
    durable: {
      goals: durable.goals,
      tasks: durable.tasks,
      followups: durable.followups,
      trusted_memory: learn.trusted_memory,
      cycle: cycle,
      events: events,
    },
    state_rows: outRows,
    events: events,
    actions: [],
    memories: aiMemories,
    errors: errors,
    config_used: cfg,
  };
}

export { hashCeo, approvalFor, canon };
