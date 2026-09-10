// Starts both the backend cluster (ports 3001, 3002, 3003) and Load Balancer (port 3000)
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=======================================================');
console.log('🚀 Starting WaveTalk Cluster + Load Balancer...');
console.log('=======================================================');

const cluster = spawn(process.execPath, [path.join(__dirname, 'cluster_launcher.js')], {
  stdio: 'inherit',
  env: { ...process.env }
});

setTimeout(() => {
  const lb = spawn(process.execPath, [path.join(__dirname, '../loadbalancer/load_balancer.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      LB_PORT: '3000',
      SYS2_HOST: '127.0.0.1', SYS2_PORT: '3001',
      SYS3_HOST: '127.0.0.1', SYS3_PORT: '3002',
      SYS4_HOST: '127.0.0.1', SYS4_PORT: '3003'
    }
  });

  const cleanup = () => {
    console.log('\nStopping cluster and load balancer...');
    cluster.kill();
    lb.kill();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}, 1200);
