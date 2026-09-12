#!/usr/bin/env node
/** First publication only. Never overwrites a repository, changes visibility or force-pushes. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,checkRelease} from './release-check.mjs';
const args=process.argv.slice(2);
const owner=(args.find(a=>a.startsWith('--owner='))||'--owner=LMPrado-DZ23').slice(8);
const name=(args.find(a=>a.startsWith('--name='))||'--name=dz23-subagents-universal-mcp').slice(7);
function invoke(command,argv,options={}) {
  const r=spawnSync(command,argv,{cwd:root,encoding:'utf8',timeout:120_000,...options});
  if(r.error)throw new Error(`BLOCKED_BY_EXTERNAL_DEPENDENCY: ${command} is unavailable or timed out`);
  return r;
}
function must(command,argv,options={}) {
  const r=invoke(command,argv,options);
  if(r.status!==0)throw new Error(`${command} failed. No publication success is claimed. ${r.stderr||''}`.slice(0,2000));
  return r.stdout?.trim()||'';
}
try {
  if(!args.includes('--public')||args.some(a=>!['--public','--dry-run'].includes(a)&&!a.startsWith('--owner=')&&!a.startsWith('--name=')))throw new Error('Usage: node scripts/publish-github.mjs --public [--dry-run] [--owner=ACCOUNT] [--name=REPOSITORY]');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner)||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name))throw new Error('Invalid repository owner/name');
  const full=`${owner}/${name}`;
  const release=checkRelease();
  must(process.execPath,['scripts/check.mjs'],{stdio:'inherit'});
  must(process.execPath,['--test'],{stdio:'inherit'});
  if(args.includes('--dry-run')){
    console.log(`DRY_RUN=PASS; would publish ${release.files.length} allowlisted files to ${full} (PUBLIC). No GitHub calls/writes made.`);
    process.exit(0);
  }
  if(fs.existsSync(path.join(root,'.git')))throw new Error('Existing Git repository detected. Use a fresh extracted package for first publication; no repository will be overwritten.');
  must('git',['--version']);must('gh',['--version']);
  const auth=invoke('gh',['auth','status','--hostname','github.com']);
  if(auth.status!==0)throw new Error('BLOCKED_BY_EXTERNAL_DEPENDENCY: run gh auth login --hostname github.com --git-protocol https --web --scopes workflow on this computer. Never paste your token in chat.');
  const user=JSON.parse(must('gh',['api','user']));
  if(user.login.toLowerCase()!==owner.toLowerCase())throw new Error(`Authenticated GitHub account does not match expected owner ${owner}. No writes performed.`);
  const existing=invoke('gh',['api',`repos/${full}`]);
  if(existing.status===0)throw new Error('Repository already exists. Refusing to overwrite content or change visibility.');
  if(!`${existing.stderr}\n${existing.stdout}`.includes('404'))throw new Error('Cannot prove repository is absent. Check connectivity and authorization; no writes performed.');
  must('git',['init','-b','main']);
  must('git',['add','--',...release.files]);
  const staged=must('git',['diff','--cached','--name-only','-z']).split('\0').filter(Boolean).sort();
  if(JSON.stringify(staged)!==JSON.stringify([...release.files].sort()))throw new Error('Staged file set differs from audited manifest. Publication stopped.');
  const version=release.version;
  must('git',['-c',`user.name=${user.login}`,'-c',`user.email=${user.id}+${user.login}@users.noreply.github.com`,'commit','-m',`Prepare DZ23 Subagents MCP v${version} open-source preview`]);
  // No --push here: use a local per-command credential helper, not global Git settings.
  must('gh',['repo','create',full,'--public','--description','Self-hosted MCP text delegation router, shared project memory and parallel model workers']);
  must('git',['remote','add','origin',`https://github.com/${full}.git`]);
  const credentialArgs=['-c','credential.helper=','-c','credential.helper=!gh auth git-credential'];
  must('git',[...credentialArgs,'push','-u','origin','main']);
  const local=must('git',['rev-parse','HEAD']);
  const remote=must('git',[...credentialArgs,'ls-remote','origin','refs/heads/main']).split(/\s+/)[0];
  const repository=JSON.parse(must('gh',['repo','view',full,'--json','nameWithOwner,visibility,url']));
  if(remote!==local||repository.visibility!=='PUBLIC')throw new Error('Post-publication verification failed. Inspect remote before retrying; do not delete it automatically.');
  console.log(`PUBLISHED=TRUE\nURL=${repository.url}\nCOMMIT=${local}\nCI=CHECK_GITHUB_ACTIONS`);
} catch(error){console.error(error.message);process.exitCode=1;}
