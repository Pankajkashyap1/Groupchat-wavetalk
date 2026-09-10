// WaveTalk Dynamic Performance-Based Load Balancer (Sys1)
// Algorithm: Performance-Based Adaptive Threshold Switching
// Metrics: Active Connections, CPU Load %, and Average Response Time
// When current backend load exceeds THRESHOLD, traffic switches dynamically to the least-loaded backend.
// Health Monitoring: Actively probes /api/metrics every 2.5s; evicts failed backends and auto-recovers.

import http from 'http';
import net from 'net';

const LB_PORT = Number(process.env.LB_PORT) || 3000;
const THRESHOLD = Number(process.env.LB_THRESHOLD) || 65; // Optimal threshold (65)
const HEALTH_INTERVAL_MS = 2500;
const MAX_FAILURES = 3;

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

// --- Load Calculation (0 to 100) ---
function computeLoadScore(b) {
  const activeConn = Math.min((b.activeProxied + (b.metrics.activeConnections || 0)) * 2, 100);
  const cpu = Math.min(b.metrics.cpuLoad || 0, 100);
  const rt = Math.min((b.metrics.avgResponseTime || 0) / 20, 100); // 2000ms -> 100
  // Weighted: 40% connections, 40% CPU, 20% latency
  return Math.round(activeConn * 0.4 + cpu * 0.4 + rt * 0.2);
}

// Dynamic Performance-Based Backend Selection with Threshold
function selectBackend() {
  const healthy = BACKENDS.filter(b => b.healthy);
  if (healthy.length === 0) return null;

  healthy.forEach(b => {
    b.score = computeLoadScore(b);
  });

  // If we have an active backend that is healthy and under the threshold, stay on it
  if (currentBackend && currentBackend.healthy && currentBackend.score < THRESHOLD) {
    return currentBackend;
  }

  // Load exceeded threshold or currentBackend unhealthy: switch to least-loaded backend
  const candidates = [...healthy].sort((a, b) => a.score - b.score);
  const selected = candidates[0];

  if (currentBackend && selected.id !== currentBackend.id) {
    console.log(`[LB] 🔄 Switch: ${currentBackend.id} (Load: ${currentBackend.score} > Threshold: ${THRESHOLD}) -> ${selected.id} (Load: ${selected.score})`);
  }

  currentBackend = selected;
  return selected;
}

// --- Health Checks & Live Metrics Polling ---
function pollBackend(b) {
  return new Promise(resolve => {
    const req = http.get(
      { host: b.host, port: b.port, path: '/api/metrics', timeout: 2000 },
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
            if (!b.healthy) {
              console.log(`[LB] ✅ Backend ${b.id} recovered and returned to pool.`);
            }
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
      if (b.failures >= MAX_FAILURES && b.healthy) {
        console.log(`[LB] ❌ Backend ${b.id} unhealthy after ${b.failures} failed probes. Evicted.`);
        b.healthy = false;
        if (currentBackend && currentBackend.id === b.id) {
          currentBackend = null;
        }
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

// Initial poll
Promise.all(BACKENDS.map(pollBackend));

// --- HTTP Proxy ---
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
    }
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'x-served-by': backend.id,
      'x-backend-load': String(backend.score),
      'x-lb-threshold': String(THRESHOLD)
    });
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
      backend.healthy = false;
      if (currentBackend && currentBackend.id === backend.id) currentBackend = null;
    }

    // Failover retry
    const fallback = selectBackend();
    if (fallback && fallback.id !== backend.id) {
      console.log(`[LB] Request failed on ${backend.id}, failing over to ${fallback.id}`);
      return proxyRequest(req, res, fallback);
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Gateway: Backend unavailable', code: 502 }));
  });

  req.pipe(proxyReq, { end: true });
}

// --- Main HTTP Server ---
const lbServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Load Balancer Telemetry Endpoint
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
  if (!backend) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Service Unavailable: No healthy backends', code: 503 }));
  }

  proxyRequest(req, res, backend);
});

// --- WebSocket Streaming Forwarding ---
lbServer.on('upgrade', (req, socket, head) => {
  const backend = selectBackend();
  if (!backend) {
    socket.destroy();
    return;
  }

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

lbServer.listen(LB_PORT, '0.0.0.0', () => {
  console.log('=======================================================');
  console.log(`[Sys1: Load Balancer] Listening on port ${LB_PORT}`);
  console.log(`[Algorithm] Performance-Based Dynamic Threshold Switching`);
  console.log(`[Threshold] Load Score > ${THRESHOLD} triggers backend switch`);
  console.log('[Configured Backends]');
  BACKENDS.forEach(b => console.log(`  - ${b.id} -> ${b.url}`));
  console.log('=======================================================');
});
