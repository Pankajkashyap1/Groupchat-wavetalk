// Sys1 Load Generator & Benchmarking Suite
// Simulates concurrent HTTP & WebSocket traffic to measure throughput, latency percentiles,
// failure rates, and load distribution across single-backend vs multi-backend configurations.

import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to compute percentiles
function getPercentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const index = Math.min(Math.floor(sortedArr.length * (p / 100)), sortedArr.length - 1);
  return sortedArr[index];
}

// Single HTTP Request with timing and header capture
function makeHttpRequest(targetUrl, path = '/api/status', method = 'GET') {
  return new Promise((resolve) => {
    const urlObj = new URL(path, targetUrl);
    const start = process.hrtime.bigint();
    
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + (urlObj.search || ''),
      method: method,
      timeout: 5000,
      headers: {
        'Connection': 'keep-alive',
        'User-Agent': 'Sys1-LoadGenerator/1.0'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const end = process.hrtime.bigint();
        const latencyMs = Number(end - start) / 1e6;
        const servedBy = res.headers['x-served-by'] || 'Unknown';
        resolve({
          success: res.statusCode >= 200 && res.statusCode < 400,
          statusCode: res.statusCode,
          latencyMs,
          servedBy
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const end = process.hrtime.bigint();
      resolve({
        success: false,
        statusCode: 504,
        latencyMs: Number(end - start) / 1e6,
        servedBy: 'Timeout'
      });
    });

    req.on('error', (err) => {
      const end = process.hrtime.bigint();
      resolve({
        success: false,
        statusCode: 500,
        latencyMs: Number(end - start) / 1e6,
        servedBy: 'Error: ' + err.code
      });
    });

    req.end();
  });
}

// Run workload at specific concurrency and total requests
export async function runWorkload({ targetUrl, concurrency, totalRequests, endpoints }) {
  const latencies = [];
  const backendCounts = {};
  let successful = 0;
  let failed = 0;
  let activeIndex = 0;

  const startTime = Date.now();

  const worker = async () => {
    while (true) {
      const current = activeIndex++;
      if (current >= totalRequests) break;

      const endpoint = endpoints[current % endpoints.length];
      const result = await makeHttpRequest(targetUrl, endpoint);

      latencies.push(result.latencyMs);
      if (result.success) {
        successful++;
        backendCounts[result.servedBy] = (backendCounts[result.servedBy] || 0) + 1;
      } else {
        failed++;
      }
    }
  };

  // Spawn concurrent worker promises
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  const durationSec = (Date.now() - startTime) / 1000;
  latencies.sort((a, b) => a - b);

  const total = successful + failed;
  const rps = durationSec > 0 ? (total / durationSec) : 0;
  const avgLatency = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  return {
    concurrency,
    totalRequests: total,
    successful,
    failed,
    durationSec: Number(durationSec.toFixed(2)),
    rps: Number(rps.toFixed(2)),
    avgLatencyMs: Number(avgLatency.toFixed(2)),
    minLatencyMs: Number((latencies[0] || 0).toFixed(2)),
    p50LatencyMs: Number(getPercentile(latencies, 50).toFixed(2)),
    p90LatencyMs: Number(getPercentile(latencies, 90).toFixed(2)),
    p95LatencyMs: Number(getPercentile(latencies, 95).toFixed(2)),
    p99LatencyMs: Number(getPercentile(latencies, 99).toFixed(2)),
    maxLatencyMs: Number((latencies[latencies.length - 1] || 0).toFixed(2)),
    backendDistribution: backendCounts
  };
}

// Full Comparative Benchmark Test Runner
export async function runComparisonBenchmark(lbUrl = 'http://127.0.0.1:3000') {
  console.log('========================================================================');
  console.log('            SYS1 LOAD GENERATOR & BENCHMARKING ENGINE                   ');
  console.log(`Target Load Balancer: ${lbUrl}`);
  console.log('========================================================================\n');

  const concurrencyLevels = [20, 50, 100, 200, 500];
  const requestsPerTier = 1500;
  const endpoints = ['/api/status', '/api/users', '/index.html', '/style.css', '/app.js'];

  // Switch LB to Single Mode (Sys2 Only)
  console.log('>>> [1/2] BENCHMARKING SCENARIO A: LOAD BALANCER WITH ONLY SYS2 (1 BACKEND) <<<');
  await makeHttpRequest(lbUrl, '/lb/set-mode', 'POST');
  await new Promise(r => {
    const req = http.request(new URL('/lb/set-mode', lbUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => r());
    req.write(JSON.stringify({ mode: 'single', algorithm: 'round-robin' }));
    req.end();
  });
  await new Promise(r => setTimeout(r, 1000));

  const singleResults = [];
  for (const c of concurrencyLevels) {
    process.stdout.write(`  Running Concurrency=${c} (${requestsPerTier} reqs)... `);
    const res = await runWorkload({
      targetUrl: lbUrl,
      concurrency: c,
      totalRequests: requestsPerTier,
      endpoints
    });
    singleResults.push(res);
    console.log(`Done. RPS=${res.rps} | Avg=${res.avgLatencyMs}ms | P95=${res.p95LatencyMs}ms | Distribution:`, res.backendDistribution);
  }

  // Switch LB to Multi Mode (Sys2, Sys3, Sys4)
  console.log('\n>>> [2/2] BENCHMARKING SCENARIO B: LOAD BALANCER WITH ALL 3 BACKENDS (SYS2, SYS3, SYS4) <<<');
  await new Promise(r => {
    const req = http.request(new URL('/lb/set-mode', lbUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => r());
    req.write(JSON.stringify({ mode: 'multi', algorithm: 'round-robin' }));
    req.end();
  });
  await new Promise(r => setTimeout(r, 1000));

  const multiResults = [];
  for (const c of concurrencyLevels) {
    process.stdout.write(`  Running Concurrency=${c} (${requestsPerTier} reqs)... `);
    const res = await runWorkload({
      targetUrl: lbUrl,
      concurrency: c,
      totalRequests: requestsPerTier,
      endpoints
    });
    multiResults.push(res);
    console.log(`Done. RPS=${res.rps} | Avg=${res.avgLatencyMs}ms | P95=${res.p95LatencyMs}ms | Distribution:`, res.backendDistribution);
  }

  // Build Comparison Matrix
  console.log('\n================================================================================================');
  console.log('                          EMPIRICAL COMPARISON TABLE                                             ');
  console.log('================================================================================================');
  console.log('| Concurrency | 1-Backend RPS | 3-Backend RPS | Speedup | 1-Backend Avg (ms) | 3-Backend Avg (ms) | Latency Red. |');
  console.log('|-------------|---------------|---------------|---------|--------------------|--------------------|--------------|');

  const comparisonData = [];
  for (let i = 0; i < concurrencyLevels.length; i++) {
    const s = singleResults[i];
    const m = multiResults[i];
    const speedup = (m.rps / s.rps).toFixed(2) + 'x';
    const latencyReduction = (((s.avgLatencyMs - m.avgLatencyMs) / s.avgLatencyMs) * 100).toFixed(1) + '%';

    comparisonData.push({
      concurrency: s.concurrency,
      singleRps: s.rps,
      multiRps: m.rps,
      speedup,
      singleAvgMs: s.avgLatencyMs,
      multiAvgMs: m.avgLatencyMs,
      singleP95Ms: s.p95LatencyMs,
      multiP95Ms: m.p95LatencyMs,
      singleP99Ms: s.p99LatencyMs,
      multiP99Ms: m.p99LatencyMs,
      latencyReduction,
      singleDistribution: s.backendDistribution,
      multiDistribution: m.backendDistribution
    });

    console.log(`| ${String(s.concurrency).padEnd(11)} | ${String(s.rps).padEnd(13)} | ${String(m.rps).padEnd(13)} | ${speedup.padEnd(7)} | ${String(s.avgLatencyMs).padEnd(18)} | ${String(m.avgLatencyMs).padEnd(18)} | ${latencyReduction.padEnd(12)} |`);
  }

  // Save to results.json
  const finalReportData = {
    timestamp: new Date().toISOString(),
    loadBalancerUrl: lbUrl,
    concurrencyTiers: concurrencyLevels,
    singleBackendResults: singleResults,
    multiBackendResults: multiResults,
    comparison: comparisonData
  };

  const resultsPath = path.join(__dirname, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(finalReportData, null, 2));
  console.log(`\n[Results Saved] Exported structured results to: ${resultsPath}`);

  return finalReportData;
}

// CLI Execution
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('load_generator.js'))) {
  const target = process.env.TARGET_URL || 'http://127.0.0.1:3000';
  runComparisonBenchmark(target).catch(console.error);
}
