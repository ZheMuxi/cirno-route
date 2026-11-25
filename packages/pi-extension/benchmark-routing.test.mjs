import assert from 'node:assert/strict';
import test from 'node:test';
import { registerClassifier } from './index.ts';
import { formatResult } from './core.mjs';
import { recommend } from './pricing.mjs';
import { switchRecommendedModel } from './routing.mjs';
import { TeamTurn } from './team-router.mjs';
import { BoardRouting, validateBoardConfig } from './benchmark-routing.mjs';

const models = ['a','b','c'].map(id => ({ provider:'demo', id, name:id, input:['text'],
  api:'example', baseUrl:'https://example.invalid', contextWindow:65536 }));
const status = {policy:'task-percentiles-v1', sources:[{source:'arena-webdev',enabled:true,version:'official-v1',count:20}]};
const profile = {input_status:'ready', primary:'frontend', secondary:'none', context_tokens:0,
  task_profile:{kind:'code_implement',difficulty:'routine',requirements:[],reusable:true}};
const book = {schema_version:'1',currency:'USD',models:Object.fromEntries(models.map(({id},i) => ['demo/'+id,
  {input_per_million:[0.1,0.5,4][i],output_per_million:[0.1,0.5,4][i],source:'user',note:'fixture',checked_at:'2025-01-01',valid_until:'9999-12-31'}]))};
function scores(catalog) {
  return {status:'ok',source:'gemma',score_scale:10,pipeline_version:status.policy,input_status:'ready',reason_codes:[],
    task_profile:profile.task_profile,boards:status.sources,candidates:catalog.map(m => ({candidate_id:m.candidate_id,
      provider:m.provider,model:m.model,hard_ok:true,basis:'measured',coverage:1,quality_level:({a:7.1,b:8.3,c:8.7})[m.model],
      evidence_ids:['arena-webdev:overall'],lookups:[],components:[],inferred:[]}))};
}

test('an alias needs independent exact mentions of both model versions', () => {
  const cfg = identity_quote => ({ models:{'demo/gpt-1':{
    canonical:'gpt-1.5', source_url:'https://example.org/models', identity_quote }} });
  assert.doesNotThrow(() => validateBoardConfig(cfg('The alias gpt-1 currently resolves to gpt-1.5.')));
  assert.throws(() => validateBoardConfig(cfg('The evaluated model is gpt-1.5 only')), /ALIAS_EVIDENCE/);
  assert.throws(() => validateBoardConfig(cfg('gpt-1 points to gpt-1.50')), /ALIAS_EVIDENCE/);
});

test('shutting down cancels queued background work and a new session can synchronize', async () => {
  const calls = [];
  const admin = { async request(_method, body) { calls.push(body.action); return status; }, async close() {} };
  const boards = new BoardRouting({}, {}, admin);
  const closing = assert.rejects(boards.start(), { name:'AbortError' });
  await boards.close();
  await closing;
  assert.deepEqual(calls, []);
  assert.equal((await boards.start()).policy, status.policy);
  assert.deepEqual(calls, ['status','due']);
  await boards.close();
});

test('decimal abilities drive all price modes, the final switch and team selection',async () => {
  const rows=models.map(m => ({candidate_id:m.id,provider:m.provider,model:m.id}));
  for (const [mode,winner] of [['cheap','a'],['balanced','b'],['premium','c']]) {
    const result=recommend(scores(rows),book,mode);
    assert.equal(result.routing.model,winner);
    let selected=models[0];
    const outcome=await switchRecommendedModel(result,{getModels:()=>models,getModel:()=>selected,
      setModel:async m=>{selected=m;return true;},isActive:()=>true,isAvailable:async()=>true,state:{}});
    assert.equal(outcome.model,winner);
    const team=new TeamTurn({coordinator:models[0],preference:mode,score:async()=>scores(rows),
      models:()=>models,prices:()=>book,guard(){},notify(){}});
    try { assert.equal((await team.assign([{role:'前端',brief:'设计书架页面'}],{model:models[0]}))[0].model,'demo/'+winner); }
    finally { team.close(); }
  }
  const r=scores(rows);
  Object.assign(r.candidates[2],{hard_ok:false});
  Object.assign(r.candidates[0],{basis:'inferred',quality_level:null,coverage:0});
  assert.equal(recommend(r,book,'cheap').routing.model,'b');
  r.candidates[1].hard_ok=false;
  assert.equal(recommend(r,book,'balanced').routing.model,'a');
});

test('Pi commands use local benchmark scores, keep /classify read-only and show versions during background sync', async () => {
  const events=new Map(), commands=new Map(), entries=[], notices=[], adminCalls=[], scoreCalls=[];
  let release;
  const syncGate=new Promise(ok=>{release=ok;});
  const admin={request:async(_,body)=>{adminCalls.push(body.action); if(body.action==='due') await syncGate; return status;},async close(){}};
  const backend={async request(method, body) {
    if(method==='benchmark_profile') return profile;
    assert.equal(method,'board_score'); scoreCalls.push(body);
    assert(!JSON.stringify(body).includes('private task')); assert(!JSON.stringify(body).includes('example.invalid'));
    return scores(body.models);
  },async close(){}};
  const ctx={mode:'rpc',cwd:process.cwd(),model:models[0],modelRegistry:{getAvailable:()=>models},
    ui:{setStatus(){},notify:m=>notices.push(m)},abort(){assert.fail('unexpected abort');}};
  const pi={registerEntryRenderer(){},registerCommand:(n,v)=>commands.set(n,v),on:(n,v)=>events.set(n,v),
    appendEntry:(k,v)=>entries.push(v),getActiveTools:()=>['read'],getThinkingLevel:()=>'off',
    async setModel(m){ctx.model=m; await events.get('model_select')({model:m,source:'set'},ctx);return true;}};
  registerClassifier(pi,{candidate_source:'pi',leaderboards:{},candidates:[]},backend,undefined,undefined,admin);
  const call=(n,arg='')=>commands.get(n).handler(arg,ctx);
  try {
    await events.get('session_start')({},ctx);
    await call('bakamodels'); assert(notices.some(m=>m.includes('official-v1')&&m.includes('后台同步中')));
    release(); await new Promise(ok=>setImmediate(ok)); await call('bakamodels','refresh');
    assert(adminCalls.includes('due')&&adminCalls.includes('refresh'));
    await call('classify','private task'); assert.equal(ctx.model.id,'a');
    assert.match(formatResult(entries.at(-1)),/8\.7\/10/);
    await call('bakarouter'); await events.get('before_agent_start')({messageType:'user',prompt:'private task'},ctx);
    assert.equal(ctx.model.id,'c');
    assert.equal(scoreCalls.length,2); assert.equal(entries.filter(e=>e.score_scale===10).length,1);
  } finally { release(); await events.get('session_shutdown')(); }
});
