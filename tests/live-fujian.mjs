// Uses only fresh synthetic records; never touches a visitor's actual code.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
const target=process.argv[2];
if(!target)throw new Error('Usage: npm run test:live -- https://your-deployment.example (creates and removes synthetic records)');
const parsed=new URL(target);
if(!['https:','http:'].includes(parsed.protocol)||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('Pass only the deployment origin, without a path, query, or fragment.');
const origin=parsed.origin;
const endpoint=origin+'/api/fujian-record';
const codes=[0,1].map(()=> 'FJ1-'+randomBytes(24).toString('base64url'));
async function request(code,method='GET',body){
 const response=await fetch(endpoint,{method,headers:{...(code?{Authorization:'Bearer '+code}:{}),Origin:origin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});
 const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw Error('API returned non-JSON status '+response.status);}
 return{response,data};
}
let created=[];
try{
 assert.equal((await request(null)).response.status,401);
 const first=await request(codes[0],'POST',{visited:['350102']});assert.equal(first.response.status,201);created.push(codes[0]);
 assert.match(first.response.headers.get('cache-control'),/no-store/);
 const op={operationId:randomUUID(),changes:[{id:'350128',visited:true}]};
 const saved=await request(codes[0],'PATCH',op);assert.equal(saved.response.status,200);
 const retry=await request(codes[0],'PATCH',op);assert.equal(retry.data.duplicate,true);assert.equal(retry.data.committedAt,saved.data.committedAt);
 assert.deepEqual((await request(codes[0])).data.visited,['350102','350128']);
 assert.equal((await request(codes[1])).response.status,404);
 assert.equal((await request(codes[1],'POST',{visited:['350527']})).response.status,201);created.push(codes[1]);
 assert.deepEqual((await request(codes[1])).data.visited,['350527']);
 const edits=['350782','350921'].map(id=>request(codes[0],'PATCH',{operationId:randomUUID(),changes:[{id,visited:true}]}));
 for(const r of await Promise.all(edits))assert.equal(r.response.status,200);
 assert.deepEqual((await request(codes[0])).data.visited,['350102','350128','350782','350921']);
 console.log('PASS: target API, private persistent storage, idempotent retry, independent recovery codes, concurrent county merge');
}finally{
 for(const code of created){const r=await request(code,'DELETE');assert.equal(r.response.status,200);assert.equal((await request(code)).response.status,410);}
 if(created.length)console.log('PASS: synthetic live test records removed and codes revoked');
}
