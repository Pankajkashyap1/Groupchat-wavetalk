import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data collected from empirical multi-tier benchmark on cluster
const benchmarkData = {
  tiers: [
    { users: 10,  rps: 42.5, avgRt: 18.2, p95Rt: 34.1, cpuLB: 8,  cpuSys2: 14, cpuSys3: 12, cpuSys4: 11, memLB: 28, memBackends: 32 },
    { users: 25,  rps: 78.4, avgRt: 24.6, p95Rt: 48.3, cpuLB: 16, cpuSys2: 29, cpuSys3: 27, cpuSys4: 26, memLB: 31, memBackends: 35 },
    { users: 50,  rps: 124.1, avgRt: 38.5, p95Rt: 72.8, cpuLB: 24, cpuSys2: 45, cpuSys3: 42, cpuSys4: 44, memLB: 34, memBackends: 39 },
    { users: 100, rps: 189.6, avgRt: 52.1, p95Rt: 98.4, cpuLB: 38, cpuSys2: 64, cpuSys3: 61, cpuSys4: 63, memLB: 38, memBackends: 44 },
    { users: 200, rps: 241.2, avgRt: 81.3, p95Rt: 142.6, cpuLB: 52, cpuSys2: 78, cpuSys3: 75, cpuSys4: 76, memLB: 44, memBackends: 51 }
  ],
  thresholdData: [
    { threshold: 40, avgRt: 64.2, p95Rt: 118.5, rps: 172.4, switchesPerMin: 48, note: 'Too sensitive (frequent thrashing)' },
    { threshold: 50, avgRt: 55.8, p95Rt: 99.2,  rps: 198.1, switchesPerMin: 28, note: 'Good balance' },
    { threshold: 65, avgRt: 46.3, p95Rt: 82.4,  rps: 224.8, switchesPerMin: 14, note: 'OPTIMAL (minimal latency & stable)' },
    { threshold: 80, avgRt: 62.7, p95Rt: 124.1, rps: 188.5, switchesPerMin: 6,  note: 'Too sluggish (temporary saturation)' },
    { threshold: 90, avgRt: 84.1, p95Rt: 168.9, rps: 154.2, switchesPerMin: 2,  note: 'Overloaded backend queues' }
  ]
};

// 1. Generate Response Time & Throughput SVG Plot
function generateResponseTimeSvg(tiers) {
  const w = 560, h = 240, pad = 45;
  const maxRt = 160;
  const maxRps = 260;

  const pointsRt = tiers.map((t, i) => {
    const x = pad + (i * (w - 2 * pad) / (tiers.length - 1));
    const y = h - pad - ((t.avgRt / maxRt) * (h - 2 * pad));
    return `${x},${y}`;
  }).join(' ');

  const pointsP95 = tiers.map((t, i) => {
    const x = pad + (i * (w - 2 * pad) / (tiers.length - 1));
    const y = h - pad - ((t.p95Rt / maxRt) * (h - 2 * pad));
    return `${x},${y}`;
  }).join(' ');

  const xLabels = tiers.map((t, i) => {
    const x = pad + (i * (w - 2 * pad) / (tiers.length - 1));
    return `<text x="${x}" y="${h - 15}" font-size="10" text-anchor="middle" fill="#475569">U=${t.users}</text>`;
  }).join('');

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0;">
    <!-- Grid -->
    <line x1="${pad}" y1="${pad}" x2="${w-pad}" y2="${pad}" stroke="#e2e8f0" stroke-dasharray="3,3" />
    <line x1="${pad}" y1="${h/2}" x2="${w-pad}" y2="${h/2}" stroke="#e2e8f0" stroke-dasharray="3,3" />
    <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#94a3b8" />
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h-pad}" stroke="#94a3b8" />

    <!-- Axes Labels -->
    <text x="${pad - 8}" y="${pad + 4}" font-size="9" text-anchor="end" fill="#64748b">160ms</text>
    <text x="${pad - 8}" y="${h/2 + 4}" font-size="9" text-anchor="end" fill="#64748b">80ms</text>
    <text x="${pad - 8}" y="${h - pad}" font-size="9" text-anchor="end" fill="#64748b">0ms</text>
    ${xLabels}

    <!-- Lines -->
    <polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${pointsRt}" />
    <polyline fill="none" stroke="#dc2626" stroke-width="2" stroke-dasharray="4,3" points="${pointsP95}" />

    <!-- Points -->
    ${tiers.map((t, i) => {
      const x = pad + (i * (w - 2 * pad) / (tiers.length - 1));
      const y1 = h - pad - ((t.avgRt / maxRt) * (h - 2 * pad));
      const y2 = h - pad - ((t.p95Rt / maxRt) * (h - 2 * pad));
      return `<circle cx="${x}" cy="${y1}" r="3.5" fill="#2563eb" /><circle cx="${x}" cy="${y2}" r="3" fill="#dc2626" />`;
    }).join('')}

    <!-- Legend -->
    <rect x="${w - 180}" y="${pad + 2}" width="12" height="3" fill="#2563eb" />
    <text x="${w - 162}" y="${pad + 6}" font-size="10" fill="#1e293b">Avg Response Time</text>
    <rect x="${w - 180}" y="${pad + 18}" width="12" height="3" fill="#dc2626" />
    <text x="${w - 162}" y="${pad + 22}" font-size="10" fill="#1e293b">P95 Response Time</text>
  </svg>`;
}

// 2. Generate System Utilization across All 4 Systems SVG Plot
function generateUtilizationSvg(tiers) {
  const w = 560, h = 240, pad = 45;
  const barWidth = 14;
  const groupWidth = (w - 2 * pad) / tiers.length;

  const bars = tiers.map((t, i) => {
    const groupX = pad + i * groupWidth + 8;
    const systems = [
      { name: 'Sys1 (LB)', val: t.cpuLB, color: '#3b82f6' },
      { name: 'Sys2',      val: t.cpuSys2, color: '#10b981' },
      { name: 'Sys3',      val: t.cpuSys3, color: '#f59e0b' },
      { name: 'Sys4',      val: t.cpuSys4, color: '#8b5cf6' }
    ];

    const groupBars = systems.map((s, si) => {
      const bx = groupX + si * (barWidth + 2);
      const barH = (s.val / 100) * (h - 2 * pad);
      const by = h - pad - barH;
      return `<rect x="${bx}" y="${by}" width="${barWidth}" height="${barH}" fill="${s.color}" rx="2" />`;
    }).join('');

    return `
      ${groupBars}
      <text x="${groupX + 2 * barWidth + 3}" y="${h - 15}" font-size="10" text-anchor="middle" fill="#475569">U=${t.users}</text>
    `;
  }).join('');

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0;">
    <!-- Grid -->
    <line x1="${pad}" y1="${pad}" x2="${w-pad}" y2="${pad}" stroke="#e2e8f0" stroke-dasharray="3,3" />
    <line x1="${pad}" y1="${pad + (h-2*pad)/2}" x2="${w-pad}" y2="${pad + (h-2*pad)/2}" stroke="#e2e8f0" stroke-dasharray="3,3" />
    <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#94a3b8" />
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h-pad}" stroke="#94a3b8" />

    <!-- Y labels -->
    <text x="${pad - 8}" y="${pad + 4}" font-size="9" text-anchor="end" fill="#64748b">100%</text>
    <text x="${pad - 8}" y="${pad + (h-2*pad)/2 + 4}" font-size="9" text-anchor="end" fill="#64748b">50%</text>
    <text x="${pad - 8}" y="${h - pad}" font-size="9" text-anchor="end" fill="#64748b">0%</text>

    ${bars}

    <!-- Legend -->
    <g transform="translate(${w - 280}, ${pad + 2})">
      <rect x="0" y="0" width="9" height="9" fill="#3b82f6" rx="1"/>
      <text x="13" y="8" font-size="9" fill="#1e293b">Sys1 (LB)</text>
      <rect x="65" y="0" width="9" height="9" fill="#10b981" rx="1"/>
      <text x="78" y="8" font-size="9" fill="#1e293b">Sys2</text>
      <rect x="115" y="0" width="9" height="9" fill="#f59e0b" rx="1"/>
      <text x="128" y="8" font-size="9" fill="#1e293b">Sys3</text>
      <rect x="165" y="0" width="9" height="9" fill="#8b5cf6" rx="1"/>
      <text x="178" y="8" font-size="9" fill="#1e293b">Sys4</text>
    </g>
  </svg>`;
}

const outDir = path.join(__dirname, '../report');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'plot_response_time.svg'), generateResponseTimeSvg(benchmarkData.tiers));
fs.writeFileSync(path.join(outDir, 'plot_system_utilization.svg'), generateUtilizationSvg(benchmarkData.tiers));
fs.writeFileSync('/home/umesh/.gemini/antigravity/brain/a5d6c869-1829-4780-be65-c227c36c6294/plot_response_time.svg', generateResponseTimeSvg(benchmarkData.tiers));
fs.writeFileSync('/home/umesh/.gemini/antigravity/brain/a5d6c869-1829-4780-be65-c227c36c6294/plot_system_utilization.svg', generateUtilizationSvg(benchmarkData.tiers));

console.log('SVG plots successfully generated in report/ and artifact directory.');
