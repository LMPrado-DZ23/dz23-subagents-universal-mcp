import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ToolError} from './errors.js';
import {addUsage} from './usage.js';

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const transientLockErrors = new Set(['EEXIST','EPERM','EBUSY','ENOTEMPTY']);
const safe = s => {
  if (typeof s !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(s)) {
    throw new Error('Invalid memory identifier: use 1-120 letters, digits, dots, underscores or hyphens; start with a letter or digit');
  }
  return s;
};
async function ensureDir(p){ await fs.mkdir(p,{recursive:true,mode:0o700}); }
// Windows refuses rename/read while another handle briefly holds the file (EPERM/EACCES/EBUSY).
const transientIoErrors = new Set(['EPERM','EACCES','EBUSY']);
const IO_RETRIES = 40;
async function atomicJson(file,obj){
  await ensureDir(path.dirname(file));
  const tmp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp,JSON.stringify(obj,null,2),{mode:0o600});
  for(let i=0;;i++){
    try{await fs.rename(tmp,file);return;}
    catch(e){
      if(!transientIoErrors.has(e.code)||i>=IO_RETRIES){await fs.rm(tmp,{force:true}).catch(()=>{});throw new ToolError('memory_write_failed','Memory file stayed busy; the write was not completed');}
      await sleep(5+Math.random()*10*Math.min(i+1,10));
    }
  }
}
async function readJson(file,fallback){
  for(let i=0;;i++){
    try{return JSON.parse(await fs.readFile(file,'utf8'));}
    catch(e){
      if(e.code==='ENOENT')return fallback;
      if(transientIoErrors.has(e.code)&&i<IO_RETRIES){await sleep(5+Math.random()*10);continue;}
      throw e;
    }
  }
}

/** Append one line; when the file grows past maxBytes keep only the newest 75%. */
async function appendBoundedLine(file,line,maxBytes){
  await ensureDir(path.dirname(file)); await fs.appendFile(file,line+'\n',{mode:0o600});
  const stat=await fs.stat(file); if(stat.size<=maxBytes)return;
  const lines=(await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean); const kept=[]; let bytes=0;
  for(let i=lines.length-1;i>=0;i--){const size=Buffer.byteLength(lines[i]+'\n');if(bytes+size>Math.floor(maxBytes*0.75))break;kept.unshift(lines[i]);bytes+=size;}
  await fs.writeFile(file,kept.join('\n')+'\n',{mode:0o600});
}

const CHECKPOINT_LISTS=['acceptance_criteria','decisions','invariants','completed_tasks','active_tasks','blocked_tasks','next_tasks','known_failures','files_read','files_changed','artifacts'];
const CHECKPOINT_SCALARS=['next_action','status','summary','goal'];
function mergeList(current,incoming,merge){
  if(merge==='replace')return [...incoming];
  const out=[...(Array.isArray(current)?current:[])];const seen=new Set(out.map(x=>JSON.stringify(x)));
  for(const item of incoming){const key=JSON.stringify(item);if(!seen.has(key)){seen.add(key);out.push(item);}}
  return out;
}
/** Only provided fields change; omitted status keeps the current status. */
export function mergeCheckpointFields(state,fields,merge='append'){
  const patch={};
  for(const key of CHECKPOINT_SCALARS)if(fields[key]!==undefined)patch[key]=fields[key];
  for(const key of CHECKPOINT_LISTS)if(fields[key]!==undefined)patch[key]=mergeList(state?.[key],fields[key],merge);
  if(fields.tests){const cur=state?.tests||{};patch.tests={...cur};for(const k of ['passed','failed','pending'])if(fields.tests[k])patch.tests[k]=mergeList(cur[k],fields.tests[k],merge);}
  return patch;
}

/**
 * In-process serialization per key (project directory). Readers and writers of one process
 * never overlap, so Windows cannot refuse a rename because this process holds the file open.
 * Not reentrant: code inside a locked section must use readJson directly.
 */
class KeyedMutex {
  constructor(){ this.tails=new Map(); }
  async run(key,fn){
    const previous=this.tails.get(key)||Promise.resolve();
    let release; const gate=new Promise(resolve=>{release=resolve;});
    const tail=previous.then(()=>gate); this.tails.set(key,tail);
    await previous;
    try{return await fn();}
    finally{release(); if(this.tails.get(key)===tail)this.tails.delete(key);}
  }
}

export class ProjectMemory {
  constructor(root, options={}){
    this.root=root;
    this.maxStoredOutputChars=options.maxStoredOutputChars||12000;
    this.maxAgentOutputs=options.maxAgentOutputs||16;
    this.maxJournalBytes=options.maxJournalBytes||1024*1024;
    this.maxEventBytes=Math.max(4096,Math.min(65536,Math.floor(this.maxJournalBytes/4)));
    this.maxCheckpoints=options.maxCheckpoints||8;
    this.local=new KeyedMutex();
  }
  projectDir(projectId){ return path.join(this.root,'projects',safe(projectId)); }
  missionDir(projectId,missionId){ return path.join(this.projectDir(projectId),'missions',safe(missionId)); }
  async withLock(projectId, fn){ const dir=this.projectDir(projectId); return this.local.run(dir,()=>this.lockAt(dir, fn)); }
  async lockAt(dir, fn){
    await ensureDir(dir); const lock=path.join(dir,'.lock');
    let acquired=false;
    for(let i=0;i<500;i++){ try{await fs.mkdir(lock,{mode:0o700});acquired=true;break;}catch(e){if(!transientLockErrors.has(e.code))throw e;await sleep(20+Math.random()*30);} }
    if(!acquired) throw new ToolError('lock_timeout',`Memory lock timeout for ${path.basename(dir)}`);
    try{return await fn();}finally{
      for(let i=0;i<20;i++){try{await fs.rm(lock,{recursive:true,force:true});break;}catch(e){if(!transientLockErrors.has(e.code)||i===19)throw e;await sleep(20+Math.random()*30);}}
    }
  }
  async initProject(projectId, data={}){
    return this.withLock(projectId, async()=>{
      const file=path.join(this.projectDir(projectId),'project.json');
      const prev=await readJson(file,null);
      const now=new Date().toISOString();
      const obj=prev||{schema:1,project_id:projectId,created_at:now,decisions:[],facts:[],artifacts:[],agents:[]};
      Object.assign(obj,data,{updated_at:now}); await atomicJson(file,obj); return obj;
    });
  }
  async getProject(projectId){const dir=this.projectDir(projectId);return this.local.run(dir,()=>readJson(path.join(dir,'project.json'),null));}
  async startMission(projectId, missionId, data={}){
    await this.initProject(projectId);
    return this.withLock(projectId, async()=>{
      const file=path.join(this.missionDir(projectId,missionId),'state.json'); const now=new Date().toISOString();
      const prev=await readJson(file,null);
      const obj=prev||{schema:1,project_id:projectId,mission_id:missionId,created_at:now,sequence:0,status:'active',goal:'',acceptance_criteria:[],completed_tasks:[],active_tasks:[],blocked_tasks:[],next_tasks:[],decisions:[],known_failures:[],files_read:[],files_changed:[],artifacts:[],tests:{passed:[],failed:[],pending:[]},agents:[]};
      Object.assign(obj,data,{updated_at:now}); await atomicJson(file,obj); return obj;
    });
  }
  async getMission(projectId,missionId){const file=path.join(this.missionDir(projectId,missionId),'state.json');return this.local.run(this.projectDir(projectId),()=>readJson(file,null));}
  async updateMission(projectId,missionId, patch={}){
    return this.withLock(projectId, async()=>{
      const file=path.join(this.missionDir(projectId,missionId),'state.json'); const cur=await readJson(file,null); if(!cur) throw new Error('Mission not found');
      const next={...cur,...patch,sequence:(cur.sequence||0)+1,updated_at:new Date().toISOString()}; await atomicJson(file,next); return next;
    });
  }

  async recordAgentResult(projectId,missionId, agent, output){
    return this.withLock(projectId, async()=>{
      const file=path.join(this.missionDir(projectId,missionId),'state.json'); const cur=await readJson(file,null); if(!cur) throw new Error('Mission not found');
      const content=String(output??'').slice(0,this.maxStoredOutputChars);
      const agents=[...(cur.agents||[]),agent].slice(-this.maxAgentOutputs*2);
      const agent_outputs=[...(cur.agent_outputs||[]),{agent_id:agent.id,role:agent.role,provider:agent.provider,model:agent.model,content,at:new Date().toISOString()}].slice(-this.maxAgentOutputs);
      const next={...cur,sequence:(cur.sequence||0)+1,updated_at:new Date().toISOString(),agents,agent_outputs,last_output:content,last_provider:agent.provider,last_model:agent.model};
      await atomicJson(file,next); return next;
    });
  }
  async appendEvent(projectId,missionId,type,payload={}){
    const ev={id:crypto.randomUUID(),ts:new Date().toISOString(),type,payload};
    let line=JSON.stringify(ev);
    if(Buffer.byteLength(line)>this.maxEventBytes){ev.payload={truncated:true,original_bytes:Buffer.byteLength(line)};line=JSON.stringify(ev);}
    return this.withLock(projectId, async()=>{
      const dir=this.missionDir(projectId,missionId); await ensureDir(dir);
      const journal=path.join(dir,'journal.jsonl');
      await fs.appendFile(journal,line+'\n',{mode:0o600});
      const stat=await fs.stat(journal);
      if(stat.size>this.maxJournalBytes){
        const text=await fs.readFile(journal,'utf8');
        const lines=text.trim().split('\n').filter(Boolean);const kept=[];let bytes=0;
        for(let i=lines.length-1;i>=0;i--){const lineBytes=Buffer.byteLength(lines[i]+'\n');if(bytes+lineBytes>Math.floor(this.maxJournalBytes*0.75))break;kept.unshift(lines[i]);bytes+=lineBytes;}
        await fs.writeFile(journal,kept.join('\n')+'\n',{mode:0o600});
      }
      return ev;
    });
  }
  async checkpoint(projectId,missionId, extra={}){
    return this.withLock(projectId, async()=>{
      const state=await readJson(path.join(this.missionDir(projectId,missionId),'state.json'),null); if(!state) throw new ToolError('mission_not_found','Mission not found');
      const seq=(state.sequence||0)+1; const cp={...state,...extra,sequence:seq,checkpoint_at:new Date().toISOString()};
      const dir=path.join(this.missionDir(projectId,missionId),'checkpoints'); await ensureDir(dir); await atomicJson(path.join(dir,`${String(seq).padStart(6,'0')}.json`),cp); await atomicJson(path.join(this.missionDir(projectId,missionId),'state.json'),cp);
      const checkpoints=(await fs.readdir(dir)).filter(x=>/^\d{6}\.json$/.test(x)).sort();
      await Promise.all(checkpoints.slice(0,-this.maxCheckpoints).map(x=>fs.rm(path.join(dir,x),{force:true})));
      return cp;
    });
  }
  usageDir(){ return path.join(this.root,'usage','daily'); }
  async getDailyUsage(day){ return this.local.run(this.usageDir(),()=>readJson(path.join(this.usageDir(),`${day}.json`),null)); }
  /** Per-call usage: mission totals, bounded usage.jsonl, project totals and the shared daily file. */
  async recordUsage(projectId,missionId,record){
    await this.withLock(projectId, async()=>{
      const dir=this.missionDir(projectId,missionId); const file=path.join(dir,'state.json'); const cur=await readJson(file,null);
      if(!cur) throw new ToolError('mission_not_found','Mission not found');
      await atomicJson(file,{...cur,usage:addUsage(cur.usage,record),updated_at:new Date().toISOString()});
      await appendBoundedLine(path.join(dir,'usage.jsonl'),JSON.stringify(record),this.maxJournalBytes);
      const projectFile=path.join(this.projectDir(projectId),'project.json'); const project=await readJson(projectFile,null);
      if(project) await atomicJson(projectFile,{...project,usage_totals:addUsage(project.usage_totals,record)});
    });
    return this.recordSystemUsage(record);
  }
  async recordSystemUsage(record){
    const day=record.at.slice(0,10);
    const dir=this.usageDir();
    return this.local.run(dir,()=>this.lockAt(dir, async()=>{
      const file=path.join(dir,`${day}.json`); const cur=await readJson(file,null);
      const next={...addUsage(cur,record),schema:1,day}; await atomicJson(file,next); return next;
    }));
  }
  async usageRecords(projectId,missionId,limit=100){
    try{return (await fs.readFile(path.join(this.missionDir(projectId,missionId),'usage.jsonl'),'utf8')).split('\n').filter(Boolean).slice(-limit).map(JSON.parse);}
    catch(e){if(e.code==='ENOENT')return[];throw e;}
  }
  /** Structured checkpoint from a harness. Creates the mission when absent. */
  async recordCheckpoint(projectId,missionId,fields={},{merge='append'}={}){
    if(!await this.getMission(projectId,missionId)) await this.startMission(projectId,missionId,{goal:fields.goal||''});
    const state=await this.getMission(projectId,missionId);
    return this.checkpoint(projectId,missionId,mergeCheckpointFields(state,fields,merge));
  }
  async recentEvents(projectId,missionId,limit=50){
    try{const lines=(await fs.readFile(path.join(this.missionDir(projectId,missionId),'journal.jsonl'),'utf8')).trim().split('\n').filter(Boolean);return lines.slice(-limit).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return[];throw e;}
  }
  async contextBundle(projectId,missionId,maxChars=120000){
    const [project,mission,events]=await Promise.all([this.getProject(projectId),this.getMission(projectId,missionId),this.recentEvents(projectId,missionId,30)]);
    const compactMission=mission?{...mission}:mission;
    const outputs=compactMission?.agent_outputs||[];
    if(compactMission){ compactMission.agent_outputs=outputs.slice(-8); if(compactMission.last_output&&compactMission.last_output.length>24000) compactMission.last_output=compactMission.last_output.slice(-24000); }
    const bundle={project,mission:compactMission,recent_events:events}; let text=JSON.stringify(bundle,null,2);
    if(text.length>maxChars) text='...[older context truncated]\n'+text.slice(-maxChars);
    return text;
  }
}
