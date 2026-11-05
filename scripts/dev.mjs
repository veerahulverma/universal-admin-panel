#!/usr/bin/env node
// Local development: runs the API server (tsx watch, port 4000) and the admin UI
// (Vite, port 5173, proxying /api to the server) together with prefixed output.
import { spawn } from 'node:child_process';

const win = process.platform === 'win32';
const procs = [
  { name: 'api', color: 36, args: ['run', 'dev', '-w', '@steward/server'], env: { ADMIN_URL: process.env.ADMIN_URL ?? 'http://localhost:5173' } },
  { name: 'admin', color: 35, args: ['run', 'dev', '-w', '@steward/admin'], env: {} },
];

let stopping = false;
const children = procs.map((p) => {
  const child = spawn('npm', p.args, { shell: win, env: { ...process.env, ...p.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
  }
  child.on('exit', (code) => {
    if (!stopping) console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
});

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // npm runs through a shell on Windows: kill the whole process tree.
    if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 800);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
