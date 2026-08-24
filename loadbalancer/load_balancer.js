// Sys1: High-Performance HTTP & WebSocket Load Balancer
// Handles reverse proxying, Round-Robin / Least-Connections scheduling,
// active health checks, connection pooling, and live telemetry for Sys2, Sys3, Sys4.

import http from 'http';
import net from 'net';
import url from 'url';

export class LoadBalancer {
  constructor(options = {}) {
    this.port = options.port || parseInt(process.env.LB_PORT || '3000', 10);
    this.algorithm = options.algorithm || 'round-robin'; // 'round-robin', 'least-connections', 'ip-hash'
    this.mode = options.mode || process.env.LB_MODE || 'multi'; // 'single' (Sys2 only) or 'multi' (Sys2, Sys3, Sys4)
    
    // Backend pool definition
    this.allBackends = [
      {
        id: 'Sys2',
        host: process.env.SYS2_HOST || '127.0.0.1',
        port: parseInt(process.env.SYS2_PORT || '3001', 10),
        healthy: true,
        activeConnections: 0,
        totalRequests: 0,
        totalBytes: 0,
        lastLatencyMs: 0,
        failCount: 0
      },
      {
        id: 'Sys3',
        host: process.env.SYS3_HOST || '127.0.0.1',
        port: parseInt(process.env.SYS3_PORT || '3002', 10),
        healthy: true,
        activeConnections: 0,
        totalRequests: 0,
        totalBytes: 0,
        lastLatencyMs: 0,
        failCount: 0
      },
      {
        id: 'Sys4',
        host: process.env.SYS4_HOST || '127.0.0.1',
        port: parseInt(process.env.SYS4_PORT || '3003', 10),
        healthy: true,
        activeConnections: 0,
        totalRequests: 0,
        totalBytes: 0,
        lastLatencyMs: 0,
        failCount: 0
      }
    ];

    this.currentIndex = 0;
    this.healthCheckInterval = null;
    this.startTime = Date.now();
    this.totalHandledRequests = 0;
    this.totalHandledWs = 0;
  }

  // Get list of active backends based on current mode and health
  getActiveBackends() {
    let pool = this.allBackends;
    if (this.mode === 'single') {
      pool = this.allBackends.filter(b => b.id === 'Sys2');
    }
    const healthyPool = pool.filter(b => b.healthy);
    return healthyPool.length > 0 ? healthyPool : pool;
  }

  // Select backend using configured load balancing algorithm
  selectBackend(req) {
    const pool = this.getActiveBackends();
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    if (this.algorithm === 'least-connections') {
      let minConn = Infinity;
      let selected = pool[0];
      for (const b of pool) {
        if (b.activeConnections < minConn) {
          minConn = b.activeConnections;
          selected = b;
        }
      }
      return selected;
    }

    if (this.algorithm === 'ip-hash') {
      const ip = (req && req.socket && req.socket.remoteAddress) || '127.0.0.1';
      let hash = 0;
      for (let i = 0; i < ip.length; i++) {
        hash = (hash * 31 + ip.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(hash) % pool.length;
      return pool[idx];
    }

    // Default: Round-Robin
    const backend = pool[this.currentIndex % pool.length];
    this.currentIndex = (this.currentIndex + 1) % pool.length;
    return backend;
  }

  // Health check worker
  startHealthChecks(intervalMs = 2500) {
    const checkOne = (backend) => {
      const start = Date.now();
      const req = http.request({
        host: backend.host,
        port: backend.port,
        path: '/api/status',
        method: 'GET',
        timeout: 1500
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            backend.healthy = true;
            backend.failCount = 0;
            backend.lastLatencyMs = Date.now() - start;
          } else {
            backend.failCount++;
            if (backend.failCount >= 2) backend.healthy = false;
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        backend.failCount++;
        if (backend.failCount >= 2) backend.healthy = false;
      });

      req.on('error', () => {
        backend.failCount++;
        if (backend.failCount >= 2) backend.healthy = false;
      });

      req.end();
    };

    this.healthCheckInterval = setInterval(() => {
      this.allBackends.forEach(checkOne);
    }, intervalMs);
    
    // Initial immediate check
    this.allBackends.forEach(checkOne);
  }

  // Create and start Load Balancer HTTP + WebSocket Server
  start() {
    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Handle WebSocket Upgrades
    this.server.on('upgrade', (req, socket, head) => {
      this.handleWebSocketUpgrade(req, socket, head);
    });

    this.startHealthChecks();

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`=======================================================`);
        console.log(`[Sys1: Load Balancer] Listening on port ${this.port}`);
        console.log(`[Algorithm] ${this.algorithm.toUpperCase()} | [Mode] ${this.mode.toUpperCase()}`);
        console.log(`[Configured Backends]`);
        this.allBackends.forEach(b => {
          console.log(`  - ${b.id} -> http://${b.host}:${b.port}`);
        });
        console.log(`=======================================================`);
        resolve(this.server);
      });
      this.server.on('error', reject);
    });
  }

  // Handle standard HTTP requests and management endpoints
  handleHttpRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);

    // Management & Metrics API
    if (parsedUrl.pathname === '/lb/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        status: 'ok',
        loadBalancer: 'Sys1-LB',
        algorithm: this.algorithm,
        mode: this.mode,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        totalRequestsHandled: this.totalHandledRequests,
        totalWebSocketsHandled: this.totalHandledWs,
        backends: this.allBackends.map(b => ({
          id: b.id,
          host: b.host,
          port: b.port,
          healthy: b.healthy,
          activeConnections: b.activeConnections,
          totalRequests: b.totalRequests,
          lastLatencyMs: b.lastLatencyMs
        }))
      }, null, 2));
    }

    if (parsedUrl.pathname === '/lb/set-mode' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.mode && (data.mode === 'single' || data.mode === 'multi')) {
            this.mode = data.mode;
            console.log(`[LB Admin] Switched mode to: ${this.mode}`);
          }
          if (data.algorithm && ['round-robin', 'least-connections', 'ip-hash'].includes(data.algorithm)) {
            this.algorithm = data.algorithm;
            console.log(`[LB Admin] Switched algorithm to: ${this.algorithm}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ success: true, mode: this.mode, algorithm: this.algorithm }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Select Backend
    const backend = this.selectBackend(req);
    if (!backend) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('503 Service Unavailable: No healthy backends available.');
    }

    this.totalHandledRequests++;
    backend.totalRequests++;
    backend.activeConnections++;

    const startTime = Date.now();

    // Prepare proxy request options
    const headers = { ...req.headers };
    headers['x-forwarded-for'] = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + req.socket.remoteAddress;
    headers['x-forwarded-proto'] = 'http';
    headers['x-forwarded-host'] = req.headers['host'] || `localhost:${this.port}`;

    const proxyReq = http.request({
      host: backend.host,
      port: backend.port,
      path: req.url,
      method: req.method,
      headers: headers,
      timeout: 10000
    }, (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };
      responseHeaders['x-load-balancer'] = 'Sys1-LB';
      responseHeaders['x-served-by'] = backend.id;
      responseHeaders['x-backend-port'] = String(backend.port);

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);

      proxyRes.on('end', () => {
        backend.activeConnections = Math.max(0, backend.activeConnections - 1);
        backend.lastLatencyMs = Date.now() - startTime;
      });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('504 Gateway Timeout');
      }
    });

    proxyReq.on('error', (err) => {
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`502 Bad Gateway: Backend ${backend.id} error (${err.message})`);
      }
    });

    req.pipe(proxyReq);
  }

  // Handle WebSocket reverse proxying (full transparent duplex pipe)
  handleWebSocketUpgrade(req, clientSocket, head) {
    const backend = this.selectBackend(req);
    if (!backend) {
      clientSocket.destroy();
      return;
    }

    this.totalHandledWs++;
    backend.activeConnections++;

    // Connect raw TCP socket to backend
    const backendSocket = net.connect(backend.port, backend.host, () => {
      // Rebuild initial upgrade HTTP request header block
      let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const val = req.rawHeaders[i + 1];
        rawRequest += `${key}: ${val}\r\n`;
      }
      rawRequest += `X-Forwarded-For: ${req.socket.remoteAddress}\r\n`;
      rawRequest += `X-Load-Balancer: Sys1-LB\r\n`;
      rawRequest += `X-Served-By: ${backend.id}\r\n\r\n`;

      backendSocket.write(rawRequest);
      if (head && head.length > 0) {
        backendSocket.write(head);
      }

      // Bi-directional pipe
      clientSocket.pipe(backendSocket);
      backendSocket.pipe(clientSocket);
    });

    const cleanup = () => {
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      clientSocket.destroy();
      backendSocket.destroy();
    };

    clientSocket.on('error', cleanup);
    backendSocket.on('error', cleanup);
    clientSocket.on('close', () => {
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      backendSocket.destroy();
    });
    backendSocket.on('close', () => {
      backend.activeConnections = Math.max(0, backend.activeConnections - 1);
      clientSocket.destroy();
    });
  }

  stop() {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.server) {
      return new Promise(resolve => this.server.close(resolve));
    }
    return Promise.resolve();
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('load_balancer.js'))) {
  const lb = new LoadBalancer();
  lb.start().catch(err => {
    console.error('Failed to start Load Balancer:', err);
    process.exit(1);
  });
}
