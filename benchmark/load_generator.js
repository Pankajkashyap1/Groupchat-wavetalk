// WaveTalk Variable Load Generator & Benchmarking Engine
// Features: variable users, random message lengths, random intervals, full stats + plots

import http from 'http';
import https from 'https';

const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:3000';
const NUM_USERS   = Number(process.env.USERS)    || 20;
const DURATION_MS = Number(process.env.DURATION) || 15000;  // 15s per tier
const MIN_MSG_LEN = 10;
const MAX_MSG_LEN = 300;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 1500;

const WORDS = ['hello','world','test','load','wavetalk','message','chat','node','server',
  'distributed','performance','latency','throughput','backend','cluster','iitbhilai',
  'network','request','response','proxy','balancer','concurrent','async','stream'];

function randomMsg() {
  const len = MIN_MSG_LEN + Math.floor(Math.random() * (MAX_MSG_LEN - MIN_MSG_LEN));
  let msg = '';
  while (msg.length < len) msg += WORDS[Math.floor(Math.random()*WORDS.length)] + ' ';
  return msg.trim().slice(0, len);
}

function randomInterval() {
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

function httpRequest(url, method, body) {
  return new Promise((resolve) => {
    const start = Date.now();
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;

    const req = lib.request({
      host: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      },
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, ms: Date.now()-start, body: raw }));
    });

    req.on('error', () => resolve({ ok: false, status: 0, ms: Date.now()-start, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 408, ms: 10000, body: '' }); });

    if (data) req.write(data);
    req.end();
  });
}

function stats(times) {
  if (!times.length) return { min:0, max:0, avg:0, p50:0, p90:0, p95:0, p99:0 };
  const sorted = [...times].sort((a,b) => a-b);
  const pct = (p) => sorted[Math.min(Math.floor(sorted.length*p/100), sorted.length-1)];
  const avg = Math.round(times.reduce((a,b)=>a+b,0) / times.length);
  return { min: sorted[0], max: sorted[sorted.length-1], avg, p50: pct(50), p90: pct(90), p95: pct(95), p99: pct(99) };
}

function bar(value, max, width=30, char='█') {
  const filled = Math.round((value / Math.max(max,1)) * width);
  return char.repeat(filled) + '░'.repeat(width - filled);
}

function printStats(label, results) {
  const ok = results.filter(r=>r.ok).length;
  const rts = results.map(r=>r.ms);
  const s = stats(rts);
  const rps = Math.round(ok / (DURATION_MS/1000) * 10) / 10;
  console.log(`\n┌─ ${label} ${'─'.repeat(Math.max(0,50-label.length))}┐`);
  console.log(`│  Requests: ${results.length} | Success: ${ok} | Errors: ${results.length-ok} | RPS: ${rps}`);
  console.log(`│  Latency  — Min:${s.min}ms  Avg:${s.avg}ms  P95:${s.p95}ms  P99:${s.p99}ms  Max:${s.max}ms`);
  console.log(`└${'─'.repeat(52)}┘`);
  return { label, requests: results.length, success: ok, errors: results.length-ok, rps, ...s };
}

async function runScenario(label, userCount, durationMs) {
  const results = [];
  const lock = { done: false };

  setTimeout(() => { lock.done = true; }, durationMs);

  const users = Array.from({ length: userCount }, (_, i) => {
    const name = `user${i+1}`;
    return (async () => {
      while (!lock.done) {
        const msg = randomMsg();
        const r = await httpRequest(`${TARGET_URL}/message`, 'POST', { 'client-name': name, msg });
        results.push(r);
        if (lock.done) break;
        await new Promise(res => setTimeout(res, randomInterval()));
      }
    })();
  });

  await Promise.all(users);
  return printStats(label, results);
}

async function runFeedTest() {
  console.log('\n[FEED TEST] GET /feed ...');
  const results = [];
  for (let i=0; i<10; i++) {
    const r = await httpRequest(`${TARGET_URL}/feed`, 'GET');
    results.push(r);
  }
  const s = stats(results.map(r=>r.ms));
  const feedData = results[0]?.body || '[]';
  let count = 0;
  try { count = JSON.parse(feedData).length; } catch {}
  console.log(`  /feed: ${count} messages | Avg latency: ${s.avg}ms | P95: ${s.p95}ms`);
  return { feedMessages: count, avgMs: s.avg };
}

function printPlot(scenarios, metric, title, unit='ms') {
  const max = Math.max(...scenarios.map(s=>s[metric]||0));
  console.log(`\n━━━ ${title} ━━━`);
  for (const s of scenarios) {
    const val = s[metric] || 0;
    console.log(`${String(s.label).padEnd(30)} ${bar(val,max,25)} ${val}${unit}`);
  }
}

async function main() {
  console.log('━'.repeat(60));
  console.log('   WaveTalk VARIABLE LOAD GENERATOR & BENCHMARK ENGINE');
  console.log(`   Target: ${TARGET_URL}`);
  console.log(`   Users: ${NUM_USERS} | Duration/tier: ${DURATION_MS/1000}s`);
  console.log(`   Msg length: ${MIN_MSG_LEN}–${MAX_MSG_LEN} chars | Interval: ${MIN_INTERVAL_MS}–${MAX_INTERVAL_MS}ms`);
  console.log('━'.repeat(60));

  // Test connectivity
  console.log('\n[1] Checking connectivity...');
  const pingR = await httpRequest(`${TARGET_URL}/feed`, 'GET');
  if (!pingR.ok) {
    console.error(`❌ Cannot reach ${TARGET_URL}/feed (status ${pingR.status})`);
    console.error('   Make sure the Load Balancer is running on Sys1.');
    process.exit(1);
  }
  console.log(`   ✅ Connected (${pingR.ms}ms)`);

  // Concurrency tiers
  const tiers = [
    { label: 'C=5  (light)',    users: 5  },
    { label: 'C=10 (moderate)', users: 10 },
    { label: 'C=20 (medium)',   users: 20 },
    { label: 'C=50 (heavy)',    users: 50 },
    { label: 'C=100 (stress)',  users: 100 }
  ];

  const allResults = [];

  console.log('\n[2] Running load tiers...\n');
  for (const tier of tiers) {
    process.stdout.write(`  Running ${tier.label} (${DURATION_MS/1000}s)... `);
    const r = await runScenario(tier.label, tier.users, DURATION_MS);
    allResults.push(r);
    process.stdout.write('done\n');
    await new Promise(res => setTimeout(res, 1000)); // cooldown between tiers
  }

  // Feed test
  const feedResult = await runFeedTest();

  // Plots
  printPlot(allResults, 'avg', 'Average Response Time', 'ms');
  printPlot(allResults, 'p95', 'P95 Response Time', 'ms');
  printPlot(allResults, 'rps', 'Throughput (RPS)', ' req/s');

  // Summary table
  console.log('\n━━━ SUMMARY TABLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Label                          Reqs  OK  Err  RPS   Avg   P95   P99');
  console.log('─'.repeat(72));
  for (const r of allResults) {
    console.log(
      String(r.label).padEnd(30) + ' ' +
      String(r.requests).padStart(5) + ' ' +
      String(r.success).padStart(4) + ' ' +
      String(r.errors).padStart(4) + ' ' +
      String(r.rps).padStart(5) + ' ' +
      String(r.avg+'ms').padStart(6) + ' ' +
      String(r.p95+'ms').padStart(6) + ' ' +
      String(r.p99+'ms').padStart(6)
    );
  }
  console.log('─'.repeat(72));
  console.log(`\nFeed check: ${feedResult.feedMessages} total messages persisted | Avg: ${feedResult.avgMs}ms`);
  console.log('\n✅ Benchmark complete.\n');
}

main().catch(console.error);
