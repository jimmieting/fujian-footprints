import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const output = path.resolve('.site-output');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
// Explicit allowlist: app assets only; no source, configuration, or local records.
cpSync('fujian', path.join(output, 'fujian'), { recursive: true });
cpSync('fujian/index.html', path.join(output, 'index.html'));
let commit = 'local';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
writeFileSync(path.join(output, 'fujian', 'build-meta.json'), JSON.stringify({ app: 'fujian-footprints', version: '0.1.0', commit, builtAt: new Date().toISOString() }) + '\n');
if (!existsSync(path.join(output, 'index.html'))) throw new Error('Missing app entry');
console.log('Built .site-output/ with root and /fujian/ entries.');
