import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInput, MAX_ROWS } from '../src/clean-v1/engine.js';

const ROWS = 100;
const ITERATIONS = 50;
const CPU_REVIEW_THRESHOLD_MS = 3;

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

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = ordered.length / 2;
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

function benchmark(input, format) {
  const samplesMs = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const before = process.cpuUsage();
    const result = cleanInput(input, format);
    const elapsed = process.cpuUsage(before);
    samplesMs.push((elapsed.user + elapsed.system) / 1000);

    assert.equal(result.source_rows, ROWS);
    assert.equal(result.data.length, ROWS);
    assert.equal(result.malformed_rows.length, 0);
  }

  const maxMs = Math.max(...samplesMs);
  const medianMs = median(samplesMs);
  const report = {
    format,
    rows: ROWS,
    runs: ITERATIONS,
    median_cpu_ms: Number(medianMs.toFixed(4)),
    max_cpu_ms: Number(maxMs.toFixed(4)),
    samples_cpu_ms: samplesMs.map(value => Number(value.toFixed(4))),
    metric: 'process.cpuUsage user+system',
    cloudflare_cpu_metric: false,
  };
  console.log('CLEAN_V1_CPU_BENCHMARK=' + JSON.stringify(report));
  return report;
}

test('benchmarks 100-row CSV and JSON cleaning 50 times each with process.cpuUsage', () => {
  assert.equal(MAX_ROWS, ROWS);
  const csv = benchmark(csvInput, 'csv');
  const json = benchmark(jsonInput, 'json');
  const exceeded = [csv, json].filter(result => result.max_cpu_ms > CPU_REVIEW_THRESHOLD_MS);

  if (exceeded.length) {
    console.log(
      'CLEAN_V1_CPU_RECOMMENDATION=OWNER_REVIEW_REQUIRED | max exceeded 3 ms for ' +
      exceeded.map(result => result.format + ':' + result.max_cpu_ms).join(',') +
      ' | propose a separate PR to lower MAX_ROWS; no automatic row-limit change',
    );
  } else {
    console.log('CLEAN_V1_CPU_RECOMMENDATION=NO_ROW_LIMIT_CHANGE_FROM_LOCAL_BENCHMARK');
  }
});
