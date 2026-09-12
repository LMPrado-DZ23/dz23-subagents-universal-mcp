import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const safe = s => {
  if (typeof s !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(s)) {
    throw new Error('Invalid memory identifier: use 1-120 letters, digits, dots, underscores or hyphens; start with a letter or digit');
  }
  return s;
};
async function ensureDir(p){ await fs.mkdir(p,{recursive:true,mode:0o700}); }
async function atomicJson(file,obj){ await ensureDir(path.dirname(file)); const tmp=`${file}.${process.pid}.${Date.now()}.tmp`; await fs.writeFile(tmp,JSON.stringify(obj,null,2),{mode:0o600}); await fs.rename(tmp,file); }
async function readJson(file,fallback){ try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;} }

export class ProjectMemory {
  constructor(root){ this.root=root; }
  projectDir(projectId){ return path.join(this.root,'projects',safe(projectId)); }
  missionDir(projectId,missionId){ return path.join(this.projectDir(projectId),'missions',safe(missionId)); }
  async withLock(projectId, fn){
    const dir=this.projectDir(projectId); await ensureDir(dir); const lock=path.join(dir,'.lock');
    let acquired=false;
    for(let i=0;i<100;i++){ try{await fs.mkdir(lock,{mode:0o700});acquired=true;break;}catch(e){if(e.code!=='EEXIST')throw e;await sleep(20+Math.random()*30);} }
    if(!acquired) throw new Error(`Memory lock timeout for ${projectId}`);
    try{return await fn();}finally{await fs.rm(lock,{recursive:true,force:true});}
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
  async getProject(projectId){return readJson(path.join(this.projectDir(projectId),'project.json'),null);}
  async startMission(projectId, missionId, data={}){
    await this.initProject(projectId);
    return this.withLock(projectId, async()=>{
      const file=path.join(this.missionDir(projectId,missionId),'state.json'); const now=new Date().toISOString();
      const prev=await readJson(file,null);
      const obj=prev||{schema:1,project_id:projectId,mission_id:missionId,created_at:now,sequence:0,status:'active',goal:'',acceptance_criteria:[],completed_tasks:[],active_tasks:[],blocked_tasks:[],next_tasks:[],decisions:[],known_failures:[],files_read:[],files_changed:[],artifacts:[],tests:{passed:[],failed:[],pending:[]},agents:[]};
      Object.assign(obj,data,{updated_at:now}); await atomicJson(file,obj); return obj;
    });
  }
  async getMission(projectId,missionId){return readJson(path.join(this.missionDir(projectId,missionId),'state.json'),null);}
  async updateMission(projectId,missionId, patch={}){
    return this.withLock(projectId, async()=>{
      const file=path.join(this.missionDir(projectId,missionId),'state.json'); const cur=await readJson(file,null); if(!cur) throw new Error('Mission not found');
      const next={...cur,...patch,sequence:(cur.sequence||0)+1,updated_at:new Date().toISOString()}; await atomicJson(file,next); return next;
    });
  }

  async recordAgentResult(projectId,missionId, agent, output){
    return this.withLock(projectId, async()=>{
      const file=path.join(this.missionDir(projectId,missionId),'state.json'); const cur=await readJson(file,null); if(!cur) throw new Error('Mission not found');
      const next={...cur,sequence:(cur.sequence||0)+1,updated_at:new Date().toISOString(),agents:[...(cur.agents||[]),agent],agent_outputs:[...(cur.agent_outputs||[]),{agent_id:agent.id,role:agent.role,provider:agent.provider,model:agent.model,content:output,at:new Date().toISOString()}],last_output:output,last_provider:agent.provider,last_model:agent.model};
      await atomicJson(file,next); return next;
    });
  }
  async appendEvent(projectId,missionId,type,payload={}){
    const ev={id:crypto.randomUUID(),ts:new Date().toISOString(),type,payload};
    return this.withLock(projectId, async()=>{
      const dir=this.missionDir(projectId,missionId); await ensureDir(dir);
      await fs.appendFile(path.join(dir,'journal.jsonl'),JSON.stringify(ev)+'\n',{mode:0o600}); return ev;
    });
  }
  async checkpoint(projectId,missionId, extra={}){
    return this.withLock(projectId, async()=>{
      const state=await this.getMission(projectId,missionId); if(!state) throw new Error('Mission not found');
      const seq=(state.sequence||0)+1; const cp={...state,...extra,sequence:seq,checkpoint_at:new Date().toISOString()};
      const dir=path.join(this.missionDir(projectId,missionId),'checkpoints'); await ensureDir(dir); await atomicJson(path.join(dir,`${String(seq).padStart(6,'0')}.json`),cp); await atomicJson(path.join(this.missionDir(projectId,missionId),'state.json'),cp); return cp;
    });
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
