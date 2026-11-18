const token = process.env.CF_TRIAL_API_TOKEN;
const account = process.env.CF_ACCOUNT_ID;
const started = process.env.CLEAN_V1_METRICS_START;

if (!token || !account || !started) {
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN | token, account, or metrics start time unavailable');
  process.exit(0);
}

const query = [
  'query CleanV1ProductionAnalytics {',
  ' cpuQuantileSchema: __type(name: "AccountWorkersInvocationsAdaptiveQuantiles") { fields { name description } }',
  ' viewer { accounts(filter: { accountTag: "' + account + '" }) {',
  ' workersInvocationsAdaptive(limit: 100, filter: {',
  '  scriptName: "atlas-clean-v1",',
  '  datetime_geq: "' + started + '",',
  '  datetime_leq: "' + new Date().toISOString() + '"',
  ' }) {',
  '  dimensions { datetime scriptName status httpResponseStatus }',
  '  sum { requests errors }',
  '  quantiles { cpuTimeP50 cpuTimeP99 }',
  ' }',
  ' } }',
  '}',
].join('\n');

let response;
try {
  response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query }),
  });
} catch {
  console.log('ACCOUNT_ANALYTICS_READ=UNKNOWN | network request failed');
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN');
  process.exit(0);
}
const payload = await response.json().catch(() => null);
if (!response.ok || !payload || payload.errors?.length || !payload.data) {
  console.log('ACCOUNT_ANALYTICS_READ=FAIL | required permission: Account Analytics: Read | HTTP=' + response.status);
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN');
  process.exit(0);
}

const fields = payload.data.cpuQuantileSchema?.fields || [];
const p50 = fields.find((field) => field.name === 'cpuTimeP50');
const p99 = fields.find((field) => field.name === 'cpuTimeP99');
const unitVerified =
  /microseconds/i.test(p50?.description || '') &&
  /microseconds/i.test(p99?.description || '');
console.log('CPU_QUANTILE_SCHEMA=' + JSON.stringify({
  cpuTimeP50: p50?.description || null,
  cpuTimeP99: p99?.description || null,
}));
console.log('CPU_QUANTILE_UNIT=' + (unitVerified ? 'MICROSECONDS' : 'UNKNOWN'));

const rows = payload.data.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
if (!rows.length) {
  console.log('UNKNOWN | no atlas-clean-v1 Analytics rows returned in the measurement window');
  console.log('INVOCATION_STATUS_COUNTS=UNKNOWN');
  console.log('HTTP_RESPONSE_STATUS_COUNTS=UNKNOWN');
  console.log('RESOURCE_OVERRUN_STATUSES=UNKNOWN');
  console.log('RESOURCE_OVERRUN_REQUESTS=UNKNOWN');
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN');
  process.exit(0);
}

const summary = rows.map((item) => ({
  datetime: item.dimensions?.datetime || null,
  status: item.dimensions?.status || 'UNKNOWN',
  httpResponseStatus: item.dimensions?.httpResponseStatus ?? null,
  requests: Number(item.sum?.requests || 0),
  errors: Number(item.sum?.errors || 0),
  cpuTimeP50: item.quantiles?.cpuTimeP50 ?? null,
  cpuTimeP99: item.quantiles?.cpuTimeP99 ?? null,
}));
console.log('CLEAN_V1_ANALYTICS_RAW=' + JSON.stringify(summary));

const invocationCounts = {};
const httpCounts = {};
let totalRequests = 0;
let totalErrors = 0;
let overrunRequests = 0;
const overrunStatuses = [];
for (const item of summary) {
  invocationCounts[item.status] = (invocationCounts[item.status] || 0) + item.requests;
  const httpKey = item.httpResponseStatus === null ? 'UNKNOWN' : String(item.httpResponseStatus);
  httpCounts[httpKey] = (httpCounts[httpKey] || 0) + item.requests;
  totalRequests += item.requests;
  totalErrors += item.errors;
  if (/exceeded.?resources|exceeded.?cpu/i.test(item.status)) {
    overrunRequests += item.requests;
    if (!overrunStatuses.includes(item.status)) overrunStatuses.push(item.status);
  }
}
console.log('ANALYTICS_TOTAL_REQUESTS=' + totalRequests);
console.log('ANALYTICS_TOTAL_ERRORS=' + totalErrors);
console.log('INVOCATION_STATUS_COUNTS=' + JSON.stringify(invocationCounts));
console.log('HTTP_RESPONSE_STATUS_COUNTS=' + JSON.stringify(httpCounts));
console.log('RESOURCE_OVERRUN_STATUSES=' + JSON.stringify(overrunStatuses));
console.log('RESOURCE_OVERRUN_REQUESTS=' + overrunRequests);
console.log('CLEAN_V1_ANALYTICS=READ_ONLY_COMPLETE');
