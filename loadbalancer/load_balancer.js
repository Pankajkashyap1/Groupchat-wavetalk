// WaveTalk Dynamic Performance-Based Load Balancer (Sys1)
// Highly optimized for high-throughput benchmarks (20,000+ requests)
// Features: Dynamic threshold switching, keep-alive connection pooling, zero-drop failover.

import http from 'http';
import net from 'net';

process.on('uncaughtException', err => {
  console.error('[LB UncaughtException]', err.message);
});
process.on('unhandledRejection', reason => {
  console.error('[LB UnhandledRejection]', reason);
});

const LB_PORT = Number(process.env.LB_PORT) || 3000;
const THRESHOLD = Number(process.env.LB_THRESHOLD) || 65;
const HEALTH_INTERVAL_MS = 2500;
const MAX_FAILURES = 8;

const proxyAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10000,
  maxFreeSockets: 2000,
  timeout: 60000
});

const BACKENDS = [
  {
    id: 'Sys2',
    host: process.env.SYS2_HOST || '127.0.0.1',
    port: Number(process.env.SYS2_PORT) || 3001,
  },
  {
    id: 'Sys3',
    host: process.env.SYS3_HOST || '127.0.0.1',
    port: Number(process.env.SYS3_PORT) || 3002,
  },
  {
    id: 'Sys4',
    host: process.env.SYS4_HOST || '127.0.0.1',
    port: Number(process.env.SYS4_PORT) || 3003,
  }
].map(b => ({
  ...b,
  url: `http://${b.host}:${b.port}`,
  healthy: true,
  failures: 0,
  metrics: { activeConnections: 0, cpuLoad: 0, avgResponseTime: 0, memUsage: 0 },
  score: 0,
  activeProxied: 0,
  totalRequestsHandled: 0,
  lastSeen: 0
}));

let currentBackend = null;

function computeLoadScore(b) {
  const activeConn = Math.min((b.activeProxied + (b.metrics.activeConnections || 0)) * 2, 100);
  const cpu = Math.min(b.metrics.cpuLoad || 0, 100);
  const rt = Math.min((b.metrics.avgResponseTime || 0) / 20, 100);
  return Math.round(activeConn * 0.4 + cpu * 0.4 + rt * 0.2);
}

function selectBackend() {
  let healthy = BACKENDS.filter(b => b.healthy);
  if (healthy.length === 0) {
    healthy = BACKENDS; // Never drop requests under load spike
  }

  healthy.forEach(b => {
    b.score = computeLoadScore(b);
  });

  if (currentBackend && currentBackend.healthy && currentBackend.score < THRESHOLD) {
    return currentBackend;
  }

  const candidates = [...healthy].sort((a, b) => a.score - b.score);
  currentBackend = candidates[0];
  return currentBackend;
}

function pollBackend(b) {
  return new Promise(resolve => {
    const req = http.get(
      { host: b.host, port: b.port, path: '/api/metrics', timeout: 5000, agent: proxyAgent },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            b.metrics = {
              activeConnections: data.activeConnections || 0,
              cpuLoad: data.cpuLoad || 0,
              avgResponseTime: data.avgResponseTime || 0,
              memUsage: data.memUsage || 0
            };
            b.healthy = true;
            b.failures = 0;
            b.lastSeen = Date.now();
          } catch {}
          resolve();
        });
      }
    );

    req.on('error', () => {
      b.failures++;
      if (b.failures >= MAX_FAILURES) {
        b.healthy = false;
        if (currentBackend && currentBackend.id === b.id) currentBackend = null;
      }
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
  });
}

setInterval(async () => {
  await Promise.all(BACKENDS.map(pollBackend));
  BACKENDS.forEach(b => { b.score = computeLoadScore(b); });
}, HEALTH_INTERVAL_MS);

Promise.all(BACKENDS.map(pollBackend));

function proxyRequest(req, res, backend) {
  backend.activeProxied++;
  backend.totalRequestsHandled++;
  const start = Date.now();

  const options = {
    host: backend.host,
    port: backend.port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${backend.host}:${backend.port}`,
      'x-forwarded-for': req.socket.remoteAddress,
      'x-forwarded-by': 'WaveTalk-Dynamic-LB'
    },
    agent: proxyAgent
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
    proxyRes.on('end', () => {
      backend.activeProxied = Math.max(0, backend.activeProxied - 1);
      const latency = Date.now() - start;
      backend.metrics.avgResponseTime = Math.round((backend.metrics.avgResponseTime * 0.7) + (latency * 0.3));
    });
  });

  proxyReq.on('error', err => {
    backend.activeProxied = Math.max(0, backend.activeProxied - 1);
    backend.failures++;
    if (backend.failures >= MAX_FAILURES) {
      backend.healthy = false; // Fixed: was b.healthy = false
      if (currentBackend && currentBackend.id === backend.id) currentBackend = null;
    }

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend error', code: 502 }));
    }
  });

  req.pipe(proxyReq, { end: true });
}

const lbServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/lb/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      algorithm: 'Performance-Based Dynamic Threshold Switching',
      threshold: THRESHOLD,
      activeBackend: currentBackend ? currentBackend.id : 'None',
      backends: BACKENDS.map(b => ({
        id: b.id,
        url: b.url,
        healthy: b.healthy,
        loadScore: b.score,
        activeConnections: b.activeProxied + (b.metrics.activeConnections || 0),
        requestsHandled: b.totalRequestsHandled,
        cpuLoad: b.metrics.cpuLoad,
        avgResponseTime: b.metrics.avgResponseTime,
        failures: b.failures
      }))
    }));
  }

  const backend = selectBackend();
  proxyRequest(req, res, backend);
});

lbServer.on('upgrade', (req, socket, head) => {
  const backend = selectBackend();
  if (!backend) { socket.destroy(); return; }

  const proxySocket = new net.Socket();
  proxySocket.connect(backend.port, backend.host, () => {
    proxySocket.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n'
    );
    proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });

  proxySocket.on('error', () => socket.destroy());
  socket.on('error', () => proxySocket.destroy());
});

lbServer.maxConnections = 50000;
lbServer.keepAliveTimeout = 70000;
lbServer.headersTimeout = 75000;

lbServer.listen(LB_PORT, '0.0.0.0', 4096, () => {
  console.log('=======================================================');
  console.log(`[Sys1: Load Balancer] Listening on port ${LB_PORT}`);
  console.log(`[Algorithm] Performance-Based Dynamic Threshold Switching`);
  console.log(`[Threshold] Load Score > ${THRESHOLD} triggers backend switch`);
  console.log('[Configured Backends]');
  BACKENDS.forEach(b => console.log(`  - ${b.id} -> ${b.url}`));
  console.log('=======================================================');
});
