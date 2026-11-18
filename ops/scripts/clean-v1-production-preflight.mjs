import assert from 'node:assert/strict';

const token = process.env.CF_TRIAL_API_TOKEN;
const account = process.env.CF_ACCOUNT_ID;
const api = 'https://api.cloudflare.com/client/v4';

if (!token || !account) {
  console.log('CF_TRIAL_API_TOKEN_PREFLIGHT=FAIL | required environment is missing');
  process.exit(1);
}

async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

const verify = await request(api + '/user/tokens/verify');
const verifyBody = await verify.json().catch(() => ({}));
console.log('CF_TRIAL_TOKEN_VERIFY_HTTP=' + verify.status);
if (!verify.ok || verifyBody.success !== true || verifyBody.result?.status !== 'active') {
  console.log('CF_TRIAL_TOKEN_AUTH=FAIL | token verification did not return active');
  process.exit(1);
}
console.log('CF_TRIAL_TOKEN_AUTH=PASS');

const scripts = await request(api + '/accounts/' + account + '/workers/scripts?per_page=1000');
const scriptsBody = await scripts.json().catch(() => ({}));
console.log('WORKER_SCRIPTS_METADATA_HTTP=' + scripts.status);
if (!scripts.ok || scriptsBody.success !== true || !Array.isArray(scriptsBody.result)) {
  console.log('WORKER_SCRIPTS_METADATA_READ=FAIL | required permission: Workers Metadata Read-Only (or a higher Workers role)');
  process.exit(1);
}
const targetExists = scriptsBody.result.some((item) =>
  [item.id, item.name, item.script_name].includes('atlas-clean-v1')
);
console.log('WORKER_SCRIPTS_METADATA_READ=PASS');
console.log('ATLAS_CLEAN_V1_WORKER_EXISTS=' + String(targetExists));
console.log('WORKER_DEPLOY_WRITE_PERMISSION=UNKNOWN | read-only requests cannot prove write authorization');
console.log(
  'WORKER_DEPLOY_ROLE_REQUIRED=' +
    (targetExists
      ? 'Workers Editor scoped to atlas-clean-v1 or Workers product'
      : 'Workers product Admin to create a new Worker'),
);

const start = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const end = new Date().toISOString();
const query =
  'query CleanV1TokenReadPreflight {' +
  ' cpuQuantileSchema: __type(name: "AccountWorkersInvocationsAdaptiveQuantiles") { fields { name description } }' +
  ' viewer { accounts(filter: { accountTag: "' + account + '" }) {' +
  ' workersInvocationsAdaptive(limit: 1, filter: {' +
  ' scriptName: "atlas-clean-v1", datetime_geq: "' + start + '", datetime_leq: "' + end + '"' +
  ' }) { sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } }' +
  ' } } }';
const analytics = await request('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  body: JSON.stringify({ query }),
});
const analyticsBody = await analytics.json().catch(() => ({}));
console.log('ACCOUNT_ANALYTICS_READ_HTTP=' + analytics.status);
if (!analytics.ok || analyticsBody.errors?.length || !analyticsBody.data?.viewer?.accounts) {
  console.log('ACCOUNT_ANALYTICS_READ=FAIL | required permission: Account Analytics: Read');
  process.exit(1);
}
console.log('ACCOUNT_ANALYTICS_READ=PASS');

const fields = analyticsBody.data.cpuQuantileSchema?.fields || [];
const p50 = fields.find((field) => field.name === 'cpuTimeP50');
const p99 = fields.find((field) => field.name === 'cpuTimeP99');
const unitVerified =
  /microseconds/i.test(p50?.description || '') &&
  /microseconds/i.test(p99?.description || '');
console.log('CPU_QUANTILE_UNIT=' + (unitVerified ? 'MICROSECONDS' : 'UNKNOWN'));
console.log('CF_TRIAL_API_TOKEN_PREFLIGHT=READ_ONLY_PASS');
console.log('NOTE | deploy write scope remains UNKNOWN until an owner-authorized deployment operation');
