import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInput, MAX_ROWS } from '../src/clean-v1/engine.js';

const ROWS = 200;
const WARMUP_RUNS = 10;
const MEASURED_RUNS = 200;
const P99_LIMIT_MS = 8;

const csvInput = [
  'Full Name,Phone Number,Created Date,Note',
  ...Array.from({ length: ROWS }, (_, index) => {
    const row = index + 1;
    return 'User ' + row + ',+96650123' + String(row).padStart(4, '0') + ',2025-10-25,record-' + row;
  }),
].join('\n');

const jsonInput = JSON.stringify(Array.from({ length: ROWS }, (_, index) => {
  const row = index + 1;
  return {
    'Full Name': 'User ' + row,
    'Phone Number': '+96650123' + String(row).padStart(4, '0'),
    'Created Date': '2025-10-25',
    Note: 'record-' + row,
  };
}));

function assertCleanResult(result) {
  assert.equal(result.source_rows, ROWS);
  assert.equal(result.data.length, ROWS);
  assert.equal(result.malformed_rows.length, 0);
}

function runOnce(input, format) {
  const before = process.cpuUsage();
  const result = cleanInput(input, format);
  const elapsed = process.cpuUsage(before);
  assertCleanResult(result);
  return (elapsed.user + elapsed.system) / 1000;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered.length / 2;
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

// Nearest-rank percentile: the ceil(p * n)-th ordered sample (1-based).
function percentileNearestRank(values, percentile) {
  assert.ok(values.length > 0);
  assert.ok(percentile > 0 && percentile <= 1);
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(percentile * ordered.length) - 1];
}

function roundMs(value) {
  return Number(value.toFixed(4));
}

function benchmark(input, format) {
  // Warm V8/Node before collecting samples; these 10 calls are not included.
  for (let iteration = 0; iteration < WARMUP_RUNS; iteration++) {
    runOnce(input, format);
  }

  const samplesMs = [];
  for (let iteration = 0; iteration < MEASURED_RUNS; iteration++) {
    samplesMs.push(runOnce(input, format));
  }

  const report = {
    format,
    rows: ROWS,
    warmup_runs_ignored: WARMUP_RUNS,
    measured_runs: MEASURED_RUNS,
    median_ms: roundMs(median(samplesMs)),
    p95_ms: roundMs(percentileNearestRank(samplesMs, 0.95)),
    p99_ms: roundMs(percentileNearestRank(samplesMs, 0.99)),
    max_ms: roundMs(Math.max(...samplesMs)),
    p99_limit_ms: P99_LIMIT_MS,
    percentile_method: 'nearest-rank',
    metric: 'process.cpuUsage user+system around synchronous cleanInput call',
    cloudflare_cpu_metric: false,
  };
  console.log('CLEAN_V1_CPU_BENCHMARK=' + JSON.stringify(report));
  return report;
}

test('benchmarks 200-row CSV and JSON after 10 warmups with 200 measured process.cpuUsage runs each', () => {
  assert.equal(MAX_ROWS, ROWS);

  const csv = benchmark(csvInput, 'csv');
  const json = benchmark(jsonInput, 'json');
  const exceeded = [csv, json].filter(result => result.p99_ms >= P99_LIMIT_MS);

  if (exceeded.length) {
    console.log(
      'CLEAN_V1_CPU_RECOMMENDATION=OWNER_REVIEW_REQUIRED | p99 must be < 8 ms; observed ' +
      exceeded.map(result => result.format + ':' + result.p99_ms + ' ms').join(',') +
      ' | propose a separate PR to lower MAX_ROWS; no automatic row-limit change',
    );
  } else {
    console.log('CLEAN_V1_CPU_RECOMMENDATION=NO_ROW_LIMIT_CHANGE_FROM_LOCAL_P99_BENCHMARK');
  }
});
