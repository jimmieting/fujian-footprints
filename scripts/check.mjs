import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { COUNTY_IDS } from '../cloud-functions/_lib/fujian-counties.js';
const root=path.resolve('.site-output');
const html=readFileSync(path.join(root,'index.html'),'utf8');
const data=JSON.parse(html.match(/<script id="mapData" type="application\/json">(.*?)<\/script>/s)[1]);
assert.equal(data.counties.length,84);assert.equal(data.cities.length,9);
assert.deepEqual([...data.counties.map(c=>c.id)].sort(),[...COUNTY_IDS].sort());
assert.equal(data.counties.filter(c=>c.type==='县').length,42);
assert.equal(data.counties.filter(c=>c.type==='市辖区').length,31);
assert.equal(data.counties.filter(c=>c.type==='县级市').length,11);
for(const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)){
 const url=match[1];if(!url.startsWith('/'))continue;
 assert.ok(existsSync(path.join(root,url.slice(1))),`Missing static asset: ${url}`);
}
const expected=['fujian','index.html'];assert.deepEqual(readdirSync(root).sort(),expected);
console.log('PASS: 84 counties / 9 cities, references valid, only public app assets in build.');
