import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLLMRoute } from '../src/autonomy/engine.js';

test('LLM router prefers available free routes',()=>{
  const r=selectLLMRoute({AI:{run:()=>{}},OPENROUTER_API_KEY:'x',GITHUB_MODELS_TOKEN:'x'});
  assert.equal(r[0].provider,'WORKERS_AI');
  assert.ok(r.every(x=>x.cost!=='paid'));
});
test('LLM router is honest when no credentials exist',()=>{
  const r=selectLLMRoute({});
  assert.equal(r.length,0);
});
