// WebSocket Load Generator & Benchmarking Tool
// Tests concurrent WebSocket connection establishment, authentication, and round-trip message broadcast through Load Balancer.

import WebSocket from 'ws';

export async function runWebSocketBenchmark(targetWsUrl = 'ws://127.0.0.1:3000', concurrentClients = 50, messagesPerClient = 10) {
  console.log('========================================================================');
  console.log(`[WebSocket Benchmark] Target: ${targetWsUrl}`);
  console.log(`Concurrent Clients: ${concurrentClients} | Messages Per Client: ${messagesPerClient}`);
  console.log('========================================================================\n');

  const clients = [];
  const latencies = [];
  let connected = 0;
  let receivedEchoes = 0;
  const startConnectTime = Date.now();

  const connectPromise = new Promise((resolve) => {
    for (let i = 0; i < concurrentClients; i++) {
      const username = `LoadUser_${i}_${Math.floor(Math.random() * 1000)}`;
      const ws = new WebSocket(targetWsUrl);

      ws.on('open', () => {
        connected++;
        // Send Auth
        ws.send(JSON.stringify({
          type: 'auth',
          username,
          pin: ''
        }));

        if (connected === concurrentClients) {
          resolve();
        }
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'auth_success') {
            // Start sending messages
            for (let m = 0; m < messagesPerClient; m++) {
              const sendTime = Date.now();
              ws.send(JSON.stringify({
                type: 'chat_group',
                text: `Test benchmark payload msg #${m} from ${username}`,
                meta: { sendTime }
              }));
            }
          } else if (data.type === 'group_message') {
            if (data.message && data.message.meta && data.message.meta.sendTime) {
              const rtt = Date.now() - data.message.meta.sendTime;
              latencies.push(rtt);
              receivedEchoes++;
            }
          }
        } catch (e) {}
      });

      ws.on('error', () => {});
      clients.push(ws);
    }
  });

  await connectPromise;
  const connectDurationMs = Date.now() - startConnectTime;
  console.log(`[WS Connection] ${connected}/${concurrentClients} clients connected in ${connectDurationMs}ms (${(connected / (connectDurationMs / 1000)).toFixed(1)} conn/sec)`);

  // Wait for message flow
  await new Promise(r => setTimeout(r, 4000));

  clients.forEach(ws => ws.close());

  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

  console.log(`[WS Message Stats] Broadcasts tracked: ${latencies.length} | Avg Latency: ${avgLatency.toFixed(2)}ms | P95 Latency: ${p95}ms\n`);

  return {
    concurrentClients,
    messagesPerClient,
    connectDurationMs,
    totalTrackedMessages: latencies.length,
    avgLatencyMs: Number(avgLatency.toFixed(2)),
    p95LatencyMs: Number(p95.toFixed(2))
  };
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('ws_benchmark.js'))) {
  runWebSocketBenchmark().catch(console.error);
}
