const token = process.env.CF_TRIAL_API_TOKEN;
const account = process.env.CF_ACCOUNT_ID;

if (!token || !account) {
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN | existing token/account unavailable');
  process.exit(1);
}

const now = new Date();
const from = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
const to = now.toISOString();
const query = `query CleanV1ProductionMetrics {
  cpuQuantileSchema: __type(name: "AccountWorkersInvocationsAdaptiveQuantiles") {
    fields { name description }
  }
  viewer {
    accounts(filter: { accountTag: "${account}" }) {
      workersInvocationsAdaptive(limit: 100, filter: {
        scriptName: "atlas-clean-v1",
        datetime_geq: "${from}",
        datetime_leq: "${to}"
      }) {
        dimensions { datetime scriptName status httpResponseStatus }
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    }
  }
}`;

let response;
let payload;
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
  payload = await response.json().catch(() => null);
} catch {
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN | GraphQL network request failed');
  console.log('CPU_QUANTILE_UNIT=UNKNOWN');
  console.log('INVOCATION_STATUS_COUNTS=UNKNOWN');
  console.log('HTTP_RESPONSE_STATUS_COUNTS=UNKNOWN');
  console.log('RESOURCE_OVERRUN=UNKNOWN');
  process.exit(1);
}

if (!response.ok || !payload || payload.errors?.length || !payload.data) {
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN | Cloudflare Analytics HTTP=' + response.status);
  console.log('CPU_QUANTILE_UNIT=UNKNOWN');
  console.log('INVOCATION_STATUS_COUNTS=UNKNOWN');
  console.log('HTTP_RESPONSE_STATUS_COUNTS=UNKNOWN');
  console.log('RESOURCE_OVERRUN=UNKNOWN');
  process.exit(1);
}

const schemaFields = payload.data.cpuQuantileSchema?.fields || [];
const p50Field = schemaFields.find(field => field.name === 'cpuTimeP50');
const p99Field = schemaFields.find(field => field.name === 'cpuTimeP99');
const unitVerified = /microseconds/i.test(p50Field?.description || '') &&
  /microseconds/i.test(p99Field?.description || '');
console.log('CPU_QUANTILE_UNIT=' + (unitVerified ? 'MICROSECONDS' : 'UNKNOWN'));

const rows = payload.data.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
if (!rows.length) {
  console.log('CLEAN_V1_ANALYTICS=UNKNOWN | no atlas-clean-v1 invocation rows in the six-minute observation window');
  console.log('ANALYTICS_WINDOW_UTC=' + from + ' .. ' + to);
  console.log('INVOCATION_STATUS_COUNTS=UNKNOWN');
  console.log('HTTP_RESPONSE_STATUS_COUNTS=UNKNOWN');
  console.log('RESOURCE_OVERRUN=UNKNOWN');
  process.exit(1);
}

const summary = rows.map(item => ({
  datetime: item.dimensions?.datetime,
  status: item.dimensions?.status ?? 'UNKNOWN',
  httpResponseStatus: item.dimensions?.httpResponseStatus ?? null,
  requests: Number(item.sum?.requests || 0),
  errors: Number(item.sum?.errors || 0),
  cpuTimeP50: item.quantiles?.cpuTimeP50 ?? null,
  cpuTimeP99: item.quantiles?.cpuTimeP99 ?? null,
}));
console.log('ANALYTICS_WINDOW_UTC=' + from + ' .. ' + to);
console.log('CLOUDFLARE_ANALYTICS_RAW=' + JSON.stringify(summary));

const invocationStatusCounts = {};
const httpResponseStatusCounts = {};
let totalRequests = 0;
let totalErrors = 0;
let resourceOverrunRequests = 0;
const resourceOverrunStatuses = [];

for (const item of summary) {
  const status = String(item.status || 'UNKNOWN');
  const requests = Number.isFinite(item.requests) ? item.requests : 0;
  invocationStatusCounts[status] = (invocationStatusCounts[status] || 0) + requests;
  const httpStatus = item.httpResponseStatus === null ? 'UNKNOWN' : String(item.httpResponseStatus);
  httpResponseStatusCounts[httpStatus] = (httpResponseStatusCounts[httpStatus] || 0) + requests;
  totalRequests += requests;
  totalErrors += Number.isFinite(item.errors) ? item.errors : 0;
  if (/exceeded(resources|cpu)/i.test(status)) {
    resourceOverrunRequests += requests;
    if (!resourceOverrunStatuses.includes(status)) resourceOverrunStatuses.push(status);
  }
}

console.log('ANALYTICS_TOTAL_REQUESTS=' + totalRequests);
console.log('ANALYTICS_TOTAL_ERRORS=' + totalErrors);
console.log('INVOCATION_STATUS_COUNTS=' + JSON.stringify(invocationStatusCounts));
console.log('HTTP_RESPONSE_STATUS_COUNTS=' + JSON.stringify(httpResponseStatusCounts));
console.log('RESOURCE_OVERRUN_STATUSES=' + JSON.stringify(resourceOverrunStatuses));
console.log('RESOURCE_OVERRUN_REQUESTS=' + resourceOverrunRequests);
console.log('RESOURCE_OVERRUN=' + (resourceOverrunRequests > 0 ? 'CONFIRMED' : 'NOT_OBSERVED_IN_RETURNED_STATUSES'));
console.log('CLEAN_V1_ANALYTICS=PASS');
