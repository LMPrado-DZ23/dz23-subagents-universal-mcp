#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root,forbiddenPath,secretDetected} from './release-check.mjs';
const rootFiles=['.dockerignore','.env.example','.gitattributes','.gitignore','COMECE_AQUI.txt','HERMES_SELF_INSTALL_PROMPT.txt','PUBLICAR_COM_HARNESS.txt','PUBLICAR_WINDOWS.cmd','Dockerfile','compose.yaml','package.json','LICENSE','README.md','README.en.md','CHANGELOG.md','CONTRIBUTING.md','CODE_OF_CONDUCT.md','SECURITY.md','SUPPORT.md','NOTICE','SBOM.spdx.json'];
function collect(folder){return fs.readdirSync(path.join(root,folder),{withFileTypes:true}).flatMap(entry=>{
  const name=`${folder}/${entry.name}`;if(forbiddenPath(name))return[];
  if(entry.isSymbolicLink())throw new Error('Symbolic links are not release inputs');
  return entry.isDirectory()?collect(name):[name];
});}
const paths=[...rootFiles,...['src','scripts','test','docs','.github','config'].flatMap(collect)].sort();
const files=paths.map(name=>{
  const bytes=fs.readFileSync(path.join(root,name));
  if(forbiddenPath(name)||secretDetected(bytes.toString('utf8')))throw new Error(`Release input rejected: ${name}`);
  return {path:name,sha256:createHash('sha256').update(bytes).digest('hex')};
});
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
fs.writeFileSync(path.join(root,'PUBLIC_FILES.json'),JSON.stringify({schema:1,version,files},null,2)+'\n');
console.log(`Manifest written for ${files.length} allowlisted files. Review changes before publishing.`);
