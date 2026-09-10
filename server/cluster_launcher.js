// Cluster Launcher for Sys2, Sys3, and Sys4 backends
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_SCRIPT = path.join(__dirname, 'server.js');

const instances = [
  { id: 'Sys2', port: 3001 },
  { id: 'Sys3', port: 3002 },
  { id: 'Sys4', port: 3003 }
];

const processes = [];

console.log('=======================================================');
console.log('Starting Backend Cluster: Sys2, Sys3, Sys4');
console.log('=======================================================');

const SHARED_DB = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'chat_database.json');

instances.forEach(({ id, port }) => {
  const env = {
    ...process.env,
    PORT: String(port),
    INSTANCE_ID: id,
    DB_FILE: SHARED_DB
  };

  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', data => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => console.log(`[${id}:${port}] ${line}`));
  });

  child.stderr.on('data', data => {
    console.error(`[${id}:${port} ERR] ${data.toString().trim()}`);
  });

  child.on('exit', (code, signal) => {
    console.log(`[${id}:${port}] Process exited with code ${code} signal ${signal}`);
  });

  processes.push({ id, port, process: child });
});

process.on('SIGINT', () => {
  console.log('\nStopping all backend instances...');
  processes.forEach(({ process }) => process.kill('SIGINT'));
  process.exit(0);
});

process.on('SIGTERM', () => {
  processes.forEach(({ process }) => process.kill('SIGTERM'));
  process.exit(0);
});
