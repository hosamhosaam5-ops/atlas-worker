const TOKENISH_VALUE = /\\b[A-Za-z0-9_-]{40,}\\b/g;
const ACCOUNT_ID = /\\b[0-9a-f]{32}\\b/gi;
const BEARER = /\\bBearer\\s+[^\\s"'\x60]+/gi;
const KEY_VALUE = /\\b((?:api[_-]?key|token|secret|account[_-]?id)\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)/gi;

export function redactWranglerOutput(input, knownSecrets = []) {
  let output = String(input ?? '');
  const values = [...new Set(knownSecrets.filter(value => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const value of values) output = output.split(value).join('***');
  output = output.replace(BEARER, 'Bearer ***');
  output = output.replace(ACCOUNT_ID, '***');
  output = output.replace(TOKENISH_VALUE, '***');
  output = output.replace(KEY_VALUE, '$1***');
  return output;
}
