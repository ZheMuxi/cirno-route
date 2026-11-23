import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SEMANTIC_MODEL, validVector } from './semantic-backend.mjs';
import { resolvePrice } from './pricing.mjs';

export const TAXONOMY = JSON.parse(readFileSync(new URL('../../src/cirno_route/resources/task-profile-v1.json', import.meta.url), 'utf8'));
// Keep old records readable, but do not reuse observations learned under the old input contract.
export const HABIT_LEARNING_REVISION = 'habit-learning-v3';
// These bounds retrieve a candidate for a separate local semantic verification.
// They never authorize the original fast path or a model switch on their own.
export const HABIT_VERIFICATION_MIN_SIMILARITY = 0.82;
export const HABIT_VERIFICATION_MIN_MARGIN = 0.01;
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export class HabitError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new HabitError(code); };
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validProfile(p) {
  return !!p && Object.keys(p).sort().join(',') === 'difficulty,kind,requirements,reusable'
    && Object.hasOwn(TAXONOMY.kinds, p.kind) && TAXONOMY.difficulties.includes(p.difficulty)
    && typeof p.reusable === 'boolean' && Array.isArray(p.requirements)
    && new Set(p.requirements).size === p.requirements.length
    && p.requirements.every(v => TAXONOMY.requirements.includes(v))
    && (!p.reusable || (!['mixed','unknown'].includes(p.kind) && p.difficulty !== 'unknown'));
}
export const profileKey = p => JSON.stringify([TAXONOMY.version,p.kind,p.difficulty,[...p.requirements].sort()]);
export function habitScope(mode, book, models, now = new Date()) {
  // Credentials never enter memory records. Endpoint/config changes invalidate old habits.
  // Research metadata can refresh without changing any routing decision. Hash only
  // currently registered models and the active prices used by quality-price-v1.
  const roster = models.map(m => {
    const price = resolvePrice(book,m.provider,m.id,now);
    const decision = price.status === 'known'
      ? [price.status,price.currency,'token',price.input_per_million,price.output_per_million]
      : [price.status,price.currency,price.status === 'subscription' ? 'subscription' : null];
    return [m.provider,m.id,m.baseUrl ?? '',m.api ?? '',m.input ?? [],decision];
  }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hash([HABIT_LEARNING_REVISION,mode,roster]);
}

// Only called for an explicit manual model selection. Never used in automatic Gemma routing or lookup.
export function manualTaskProfile(input) {
  if (typeof input !== 'string' || input.length > 1200 || input.length < 6) return null;
  const t = input.trim().replace(/^(?:请|帮我|请帮我|please\s+|can you\s+|could you\s+)/i,'');
  const patterns = {
    translate: /^(?:翻译|将.{0,50}译成|把.{0,50}翻译|translate\b|traduc[ei]\b|traduire\b|übersetz)/i,
    summarize: /^(?:总结|概括|摘要|summari[sz]e\b|résum|resum[ei]\b)/i,
    extract: /^(?:提取|从.{0,40}提取|extract\b)/i,
    code_explain: /^(?:解释|explain\b).{0,35}(?:代码|函数|程序|code|function|script)/i,
    code_debug: /^(?:修复|调试|debug\b|fix\b).{0,40}(?:代码|函数|程序|错误|bug|code|function|error)/i,
    code_test: /^(?:编写|补充|write|add).{0,30}(?:单元测试|测试用例|unit tests?|test cases?)/i,
    code_implement: /^(?:(?:用|使用).{0,20})?(?:实现|编写|写|implement\b|write\b).{0,50}(?:函数|程序|脚本|function|program|script)/i,
    code_design: /^(?:设计|design\b).{0,30}(?:架构|系统|architecture|system)/i,
    write_create: /^(?:写|创作|撰写|write\b|compose\b).{0,35}(?:文章|文案|故事|诗|article|copy|story|poem)/i,
    write_edit: /^(?:润色|改写|重写|rewrite\b|proofread\b|polish\b)/i,
    math_calculate: /^(?:计算|求值|calculate\b|compute\b)/i,
    math_prove: /^(?:证明|prove\b|demuestra\b)/i,
    qa: /^(?:什么是|为什么|what is\b|why\b|qué es\b)/i,
    plan: /^(?:制定|安排|plan\b).{0,35}(?:计划|行程|schedule|trip|plan)/i,
    research: /^(?:搜索|检索|search\b|research\b)/i,
  };
  const kinds = Object.entries(patterns).filter(([,p])=>p.test(t)).map(([k])=>k);
  if (kinds.length !== 1 || /(?:然后|同时|并且|and then|also\b)/i.test(t)) return null;
  if (/(?:上述|刚才|这个|这段|上面|下面|previous|above|following|this code)/i.test(t) && !/[\n：:]\s*\S/.test(t)) return null;
  if (['translate','summarize','extract','write_edit','code_explain','code_debug'].includes(kinds[0])
    && !/[\n：:]\s*\S|[“"「][^”"」]+[”"」]|```/.test(t)
    && !(kinds[0]==='translate' && /^(?:把|将)\S+翻译|^translate\s+\S+\s+(?:into|to)\s+/i.test(t))) return null;
  const requirements = [];
  if (/联网|搜索|实时|browse|search|real.time/i.test(t)) requirements.push('web');
  if (/调用工具|执行命令|修改文件|run command|edit files/i.test(t)) requirements.push('tools');
  if (/图片|图像|image|photo/i.test(t)) return null;
  if (/严格.?JSON|只输出.?JSON|valid JSON|only JSON/i.test(t)) requirements.push('structured_output');
  return { kind:kinds[0], difficulty:/并发|一致性|跨模块|架构|严谨|concurren|distributed|architecture|rigorous/i.test(t) ? 'complex':'routine', requirements, reusable:true };
}

const winner = group => {
  const ranked = [...group.counts].sort((a,b)=>b.count-a.count);
  return ranked[0] && ranked[0].count !== ranked[1]?.count ? ranked[0] : null;
};
export const cosine = (a,b) => a.reduce((sum,v,i)=>sum+v*b[i],0);

function rankGroups(data, scope, vector) {
  return data.groups.filter(g=>g.scope===scope && g.samples.length).map(group=>({group,
    similarity:Math.max(...group.samples.map(s=>cosine(vector,s.vector)))})).sort((a,b)=>b.similarity-a.similarity);
}

function match(data, scope, vector, cfg) {
  if(!data.enabled) return null;
  const ranked=rankGroups(data,scope,vector);
  const best=ranked[0]; if(!best || best.similarity<cfg.min_similarity) return null;
  // Compare against EVERY competing type, even types that have not reached the count threshold.
  if(ranked[1] && best.similarity-ranked[1].similarity<cfg.min_margin) return null;
  const selected=winner(best.group);
  if(!selected || selected.count<data.threshold) return null;
  return {...selected,profile:best.group.profile,similarity:best.similarity,threshold:data.threshold};
}

function retainRepresentatives(samples) {
  if(samples.length<=8) return samples;
  // Evict the older member of the closest pair. Repeated same-language rewrites
  // should not displace distinct, already learned language/wording representatives.
  // This does not invent translated samples, widen the threshold or classify the task.
  let redundant=0, closest=-Infinity;
  for(let i=0;i<samples.length;i++) for(let j=i+1;j<samples.length;j++) {
    const similarity=cosine(samples[i].vector,samples[j].vector);
    if(similarity>closest) {closest=similarity;redundant=i;}
  }
  return samples.filter((_,index)=>index!==redundant);
}

export class HabitStore {
  constructor(cfg) { this.cfg=cfg; this.file=cfg.file; }
  fresh() { return {schema_version:'1',fingerprint:SEMANTIC_MODEL.fingerprint,enabled:this.cfg.enabled,
    threshold:this.cfg.threshold,groups:[],receipts:[]}; }
  read() {
    let data;
    try {
      if (statSync(this.file).size>16000000) fail('HABITS_FILE_INVALID');
      data=JSON.parse(readFileSync(this.file,'utf8'));
    } catch (e) { if(e.code==='ENOENT') return this.fresh(); fail('HABITS_FILE_INVALID'); }
    if(data.schema_version!=='1' || data.fingerprint!==SEMANTIC_MODEL.fingerprint
      || typeof data.enabled!=='boolean' || !Number.isInteger(data.threshold) || data.threshold<1 || data.threshold>1000
      || !Array.isArray(data.groups) || data.groups.length>128 || !Array.isArray(data.receipts) || data.receipts.length>512
      || data.receipts.some(id=>typeof id!=='string' || id.length>64)) fail('HABITS_FILE_INVALID');
    const keys=new Set();
    for(const g of data.groups) {
      if(!validProfile(g.profile) || !g.profile.reusable || !digest(g.scope) || g.key!==hash([g.scope,profileKey(g.profile)])
        || keys.has(g.key) || !Array.isArray(g.counts) || g.counts.length>128
        || !Array.isArray(g.samples) || g.samples.length>8) fail('HABITS_FILE_INVALID');
      keys.add(g.key);
      const models=new Set();
      for(const c of g.counts) {
        const key=JSON.stringify([c.provider,c.model]);
        if(!text(c.provider)||!text(c.model)||!Number.isSafeInteger(c.count)||c.count<1||models.has(key)) fail('HABITS_FILE_INVALID');
        models.add(key);
      }
      if(g.samples.some(s=>!digest(s.hash)||!validVector(s.vector))) fail('HABITS_FILE_INVALID');
    }
    return data;
  }
  async update(fn, resetInvalid = false) {
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
    const lock=this.file+'.lock'; let fd;
    for(let attempt=0;attempt<100;attempt++) {
      try { fd=openSync(lock,'wx',0o600); writeFileSync(fd,String(process.pid)); break; }
      catch(e) {
        if(e.code!=='EEXIST') fail('HABITS_SAVE_FAILED');
        try {
          const pid=Number(readFileSync(lock,'utf8'));
          if(Number.isInteger(pid)&&pid>0) {
            try { process.kill(pid,0); } catch(err) { if(err.code==='ESRCH') unlinkSync(lock); }
          } else if(Date.now()-statSync(lock).mtimeMs>30000) unlinkSync(lock);
        } catch {}
        await delay(20);
      }
    }
    if(fd===undefined) fail('HABITS_BUSY');
    const temp=this.file+'.'+randomUUID()+'.tmp';
    try {
      let data;
      try { data=this.read(); } catch(error) { if(!resetInvalid) throw error; data=this.fresh(); }
      const result=fn(data);
      if(result===false) return false;
      const raw=JSON.stringify(data);
      if(Buffer.byteLength(raw)>16000000) fail('HABITS_CAPACITY_REACHED');
      writeFileSync(temp,raw+'\n',{flag:'wx',mode:0o600}); renameSync(temp,this.file);
      return result ?? true;
    } finally { closeSync(fd); try{unlinkSync(lock);}catch{} try{unlinkSync(temp);}catch{} }
  }
  enabled() { return this.read().enabled; }
  async configure(options) {
    return this.update(data=>{
      if(options.enabled!==undefined) {
        if(typeof options.enabled!=='boolean') fail('HABITS_CONFIG_INVALID');
        data.enabled=options.enabled;
      }
      if(options.threshold!==undefined) {
        if(!Number.isInteger(options.threshold)||options.threshold<1||options.threshold>1000) fail('HABITS_THRESHOLD_INVALID');
        data.threshold=options.threshold;
      }
      if(options.clear) {data.groups=[];data.receipts=[];}
    }, options.clear === true);
  }
  eligible(scope) {
    const data=this.read();
    return data.enabled && data.groups.some(g=>g.scope===scope && (winner(g)?.count??0)>=data.threshold);
  }
  lookup(scope,vector) {
    if(!validVector(vector)) fail('SEMANTIC_VECTOR_INVALID');
    return match(this.read(),scope,vector,this.cfg);
  }
  lookupExact(scope,taskHash) {
    if(!digest(taskHash)) fail('HABITS_TASK_HASH_INVALID');
    const data=this.read();
    const samples=data.groups.filter(g=>g.scope===scope).flatMap(g=>g.samples).filter(s=>s.hash===taskHash);
    if(!samples.length) return null;
    const vector=samples[0].vector;
    // Different vectors for the same text/model fingerprint are uncertain: re-encode normally.
    if(samples.some(s=>s.vector.some((value,index)=>value!==vector[index]))) return null;
    // Reuse only the stored embedding. Threshold, competing groups and winner checks remain identical.
    return match(data,scope,vector,this.cfg);
  }
  verificationCandidate(scope,vector) {
    if(!validVector(vector)) fail('SEMANTIC_VECTOR_INVALID');
    const data=this.read();
    if(!data.enabled) return null;
    // Rank ALL groups first. An immature or ambiguous closest group cannot be
    // skipped in favour of an easier-to-verify, already mature runner-up.
    const ranked=rankGroups(data,scope,vector), best=ranked[0];
    if(!best || best.similarity<HABIT_VERIFICATION_MIN_SIMILARITY) return null;
    if(ranked[1] && best.similarity-ranked[1].similarity<HABIT_VERIFICATION_MIN_MARGIN) return null;
    const selected=winner(best.group);
    if(!selected || selected.count<data.threshold) return null;
    return {...selected,group_key:best.group.key,profile:best.group.profile,
      similarity:best.similarity,threshold:data.threshold};
  }
  lookupVerified(scope,vector,profile) {
    if(!validVector(vector)) fail('SEMANTIC_VECTOR_INVALID');
    if(!validProfile(profile) || !profile.reusable) return null;
    // Re-read the current store after verification: count, threshold, scope,
    // closest group and enabled state may have changed while Gemma was running.
    const candidate=this.verificationCandidate(scope,vector);
    return candidate && profileKey(candidate.profile)===profileKey(profile) ? candidate : null;
  }
  async record({id,source,scope,profile,embedding,taskHash,provider,model,shouldRecord=()=>true}) {
    if(!['gemma','manual'].includes(source)) return false; // Habit hits can never reinforce counts or samples.
    if(!validProfile(profile)||!profile.reusable||!validVector(embedding)||!digest(scope)||!digest(taskHash)
      ||!text(provider)||!text(model)||typeof id!=='string'||id.length>64) fail('HABITS_RECORD_INVALID');
    return this.update(data=>{
      if(!data.enabled || !shouldRecord() || data.receipts.includes(id)) return false;
      const key=hash([scope,profileKey(profile)]);
      let group=data.groups.find(g=>g.key===key);
      if(!group) {
        if(data.groups.length>=128) fail('HABITS_CAPACITY_REACHED');
        group={key,scope,profile,counts:[],samples:[]};data.groups.push(group);
      }
      let count=group.counts.find(c=>c.provider===provider&&c.model===model);
      if(!count) {
        if(group.counts.length>=128) fail('HABITS_CAPACITY_REACHED');
        count={provider,model,count:0};group.counts.push(count);
      }
      count.count++;
      if(!group.samples.some(s=>s.hash===taskHash)) {
        group.samples=retainRepresentatives([...group.samples,{hash:taskHash,vector:embedding}]);
      }
      data.receipts.push(id);data.receipts=data.receipts.slice(-512);
    });
  }
}
