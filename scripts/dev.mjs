import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRecordHandler } from '../cloud-functions/_lib/fujian-record-core.js';

const root=path.resolve('.site-output'),dataDirectory=path.resolve('.dev-data');
const port=Number(process.env.PORT||4875);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT must be an integer from 1024 to 65535');
const built=spawnSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});if(built.status!==0)process.exit(built.status||1);
mkdirSync(dataDirectory,{recursive:true});
const dataFile=path.join(dataDirectory,'records.json');
const data=new Map(existsSync(dataFile)?JSON.parse(readFileSync(dataFile,'utf8')):[]);
function persist(){const temporary=dataFile+'.tmp';writeFileSync(temporary,JSON.stringify([...data]),{mode:0o600});renameSync(temporary,dataFile);}
const store={async get(key){return data.has(key)?structuredClone(data.get(key)):null;},async setJSON(key,value){data.set(key,structuredClone(value));persist();},async list({prefix}){return{blobs:[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))};},async delete(key){data.delete(key);persist();}};
const handler=createRecordHandler({store});
const mime={'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8','.js':'text/javascript;charset=utf-8','.json':'application/json;charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(url.pathname==='/api/fujian-record'){
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>8192){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'body_too_large'}));return;}chunks.push(chunk);}
   const response=await handler(new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}));
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  let file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  if((await stat(file)).isDirectory())file=path.join(file,'index.html');
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(await readFile(file));
 }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Fujian Footprints: http://127.0.0.1:${port}/ (local file storage in .dev-data/)`));
