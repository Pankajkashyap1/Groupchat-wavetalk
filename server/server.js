// WaveTalk Real-Time Chat Server
// Features: HTTP static file server, WebSocket real-time messaging, Group Chat,
// Encrypted Direct Messages, User Presence, Persistent Shared Database,
// /message POST, /feed GET, /api/metrics (for dynamic load balancer)

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { db } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || `Sys:${PORT}`;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// --- Metrics tracking for dynamic load balancer ---
let activeConnections = 0;
let totalRequests = 0;
let totalResponseTime = 0;
const recentResponseTimes = []; // sliding window of last 100

function recordResponseTime(ms) {
  recentResponseTimes.push(ms);
  if (recentResponseTimes.length > 100) recentResponseTimes.shift();
  totalResponseTime += ms;
  totalRequests++;
}

function getAvgResponseTime() {
  if (recentResponseTimes.length === 0) return 0;
  return Math.round(recentResponseTimes.reduce((a,b)=>a+b,0) / recentResponseTimes.length);
}

function getCpuLoad() {
  const cpus = os.cpus();
  const avg = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a,b)=>a+b,0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total);
  }, 0) / cpus.length;
  return Math.round(avg * 100);
}

function getMemUsage() {
  const total = os.totalmem(), free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

// --- Parse request body ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  activeConnections++;

  res.on('finish', () => {
    activeConnections--;
    recordResponseTime(Date.now() - start);
  });

  res.setHeader('X-Backend-Server', INSTANCE_ID);
  res.setHeader('X-Backend-Port', String(PORT));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // ============================================================
  // REQUIRED API ROUTE: /message (POST or GET)
  // Input: "client-name" and "msg"
  // Returns: { "id": "...", "status": "ok"|"duplicate", "sender": "...", "msg": "...", "timestamp": ... }
  // ============================================================
  if (pathname === '/message' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let body = {};
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try { body = JSON.parse(raw); } catch {
          const params = new URLSearchParams(raw);
          body = {
            'client-name': params.get('client-name') || params.get('client_name') || params.get('sender'),
            msg: params.get('msg') || params.get('message') || params.get('text'),
            id: params.get('id') || params.get('message_id') || params.get('msg_id')
          };
        }
      }

      // Check query parameters as fallback
      const clientName = body['client-name'] || body.client_name || body.sender ||
                         urlObj.searchParams.get('client-name') || urlObj.searchParams.get('client_name') || urlObj.searchParams.get('sender') || 'anonymous';
      const text = body.msg || body.message || body.text ||
                   urlObj.searchParams.get('msg') || urlObj.searchParams.get('message') || urlObj.searchParams.get('text') || '';
      const msgId = body.id || body.message_id || body.msg_id || body['message-id'] || urlObj.searchParams.get('id') || undefined;

      const sender = String(clientName).trim().slice(0, 64);
      const cleanMsg = String(text).trim().slice(0, 2000);

      if (!cleanMsg) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'msg is required', status: 'error' }));
      }

      const saved = db.saveGroupMessage({ id: msgId, sender, text: cleanMsg });

      // Broadcast to WebSocket clients only if any connected
      if (wss && wss.clients && wss.clients.size > 0) {
        broadcast({ type: 'group_message', message: saved });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: saved.id,
        status: saved.duplicate ? 'duplicate' : 'ok',
        sender: saved.sender,
        msg: saved.text,
        timestamp: saved.timestamp
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message, status: 'error' }));
    }
  }

  // ============================================================
  // REQUIRED API ROUTE: GET /feed
  // Returns all messages: [{ id, sender, msg, timestamp }]
  // ============================================================
  if (pathname === '/feed' && req.method === 'GET') {
    const feed = db.getPublicFeed();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(feed));
  }

  // ============================================================
  // METRICS ENDPOINT: GET /api/metrics
  // Used by Load Balancer for dynamic scoring
  // ============================================================
  if (pathname === '/api/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      instance: INSTANCE_ID,
      port: Number(PORT),
      activeConnections,
      cpuLoad: getCpuLoad(),
      memUsage: getMemUsage(),
      avgResponseTime: getAvgResponseTime(),
      totalRequests,
      uptime: Math.round(process.uptime()),
      timestamp: Date.now()
    }));
  }

  // ============================================================
  // EXISTING API ENDPOINTS
  // ============================================================
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      instance: INSTANCE_ID,
      port: Number(PORT),
      uptime: process.uptime(),
      onlineUsers: getOnlineUsernames().length,
      totalUsers: db.getAllUsers().length,
      timestamp: Date.now()
    }));
  }

  if (pathname === '/api/users') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getRosterWithStatus()));
  }

  // ============================================================
  // STATIC FILE SERVING
  // ============================================================
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(filePath).replace(/^(\.\.[\\/])+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (!path.extname(filePath)) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(indexPath, (readErr, content) => {
          if (readErr) { res.writeHead(404); return res.end('404 Not Found'); }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        });
      }
      res.writeHead(404); return res.end('404 Not Found');
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(fullPath).pipe(res);
  });
});

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });
const socketUserMap = new Map();

function getOnlineUsernames() {
  const online = new Set();
  for (const [ws, info] of socketUserMap.entries()) {
    if (ws.readyState === ws.OPEN && info.username) online.add(info.username.toLowerCase());
  }
  return [...online];
}

function getSocketsForUser(username) {
  const lower = (username||'').toLowerCase(), sockets = [];
  for (const [ws, info] of socketUserMap.entries()) {
    if (ws.readyState === ws.OPEN && info.username && info.username.toLowerCase()===lower) sockets.push(ws);
  }
  return sockets;
}

function getRosterWithStatus() {
  const onlineSet = new Set(getOnlineUsernames());
  return db.getAllUsers().map(u => ({ ...u, isOnline: onlineSet.has(u.username.toLowerCase()) }))
    .sort((a,b) => { if (a.isOnline!==b.isOnline) return a.isOnline?-1:1; return a.username.localeCompare(b.username); });
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch(e){} }
}

function broadcast(obj, excludeWs = null) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== excludeWs && client.readyState === client.OPEN) { try { client.send(payload); } catch(e){} }
  }
}

function broadcastRoster() {
  broadcast({ type: 'roster_update', roster: getRosterWithStatus(), onlineCount: getOnlineUsernames().length });
}

wss.on('connection', (ws, req) => {
  const clientInfo = { username: null, alive: true, ip: req.socket.remoteAddress };
  socketUserMap.set(ws, clientInfo);

  ws.on('pong', () => { clientInfo.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return sendJson(ws, { type: 'error', message: 'Invalid JSON' }); }
    const { type, payload } = msg;

    if (type === 'auth_join') {
      const { username, pin } = payload || {};
      try {
        const authResult = db.getOrCreateUser(username, pin);
        if (authResult.error) return sendJson(ws, { type: 'auth_error', reason: authResult.error, username: authResult.username });
        const user = authResult.user;
        clientInfo.username = user.username;
        clientInfo.joinedAt = user.joinedAt;
        const groupHistory = authResult.isNew ? [] : db.getGroupHistory(100, user.joinedAt);
        sendJson(ws, {
          type: 'auth_success',
          user: { username: user.username, joinedAt: user.joinedAt, avatarColor: user.avatarColor, isNew: authResult.isNew },
          groupHistory,
          personalConversations: db.getAllPersonalConversationsForUser(user.username),
          roster: getRosterWithStatus()
        });
        broadcast({ type: 'system_event', event: 'user_joined', username: user.username, text: `${user.username} joined the chat`, timestamp: Date.now() }, ws);
        broadcastRoster();
        console.log(`[AUTH] ${user.username} joined. Online: ${getOnlineUsernames().length}`);
      } catch (err) { sendJson(ws, { type: 'auth_error', reason: err.message }); }
      return;
    }

    if (!clientInfo.username) return sendJson(ws, { type: 'auth_required', message: 'Please log in first' });
    const currentUsername = clientInfo.username;
    db.updateUserLastSeen(currentUsername);

    if (type === 'chat_group') {
      const text = String(payload?.text || '').trim();
      if (!text) return;
      const savedMsg = db.saveGroupMessage({ sender: currentUsername, text: text.slice(0, 2000) });
      broadcast({ type: 'group_message', message: savedMsg });
      return;
    }

    if (type === 'chat_personal') {
      const { recipient, ciphertext, iv, salt, meta } = payload || {};
      if (!recipient || !ciphertext || !iv) return sendJson(ws, { type: 'error', message: 'Incomplete encrypted message' });
      const recipientUser = db.getUser(recipient);
      if (!recipientUser) return sendJson(ws, { type: 'error', message: `User ${recipient} does not exist.` });
      const savedMsg = db.savePersonalMessage({ sender: currentUsername, recipient: recipientUser.username, ciphertext, iv, salt: salt||'', meta: meta||{} });
      const recipientSockets = getSocketsForUser(recipientUser.username);
      recipientSockets.forEach(sock => sendJson(sock, { type: 'personal_message', message: savedMsg }));
      const isRecipientOnline = recipientSockets.length > 0;
      getSocketsForUser(currentUsername).forEach(sock => sendJson(sock, { type: 'personal_message_sent', message: savedMsg, delivered: isRecipientOnline }));
      return;
    }

    if (type === 'get_personal_history') {
      const { partner } = payload || {};
      if (!partner) return;
      const history = db.getPersonalHistory(currentUsername, partner, 100);
      const updatedIds = db.markPersonalMessagesAsRead(currentUsername, partner);
      sendJson(ws, { type: 'personal_history', partner, history });
      if (updatedIds.length > 0) {
        getSocketsForUser(partner).forEach(sock => sendJson(sock, { type: 'messages_read_by_partner', partner: currentUsername, messageIds: updatedIds }));
      }
      return;
    }

    if (type === 'typing') {
      const { target, isTyping } = payload || {};
      if (target === 'group') {
        broadcast({ type: 'typing_update', target: 'group', username: currentUsername, isTyping: !!isTyping }, ws);
      } else if (target) {
        getSocketsForUser(target).forEach(sock => sendJson(sock, { type: 'typing_update', target: 'personal', sender: currentUsername, isTyping: !!isTyping }));
      }
      return;
    }

    if (type === 'mark_read') {
      const { sender } = payload || {};
      if (sender) {
        const updatedIds = db.markPersonalMessagesAsRead(currentUsername, sender);
        sendJson(ws, { type: 'marked_read_ok', sender });
        if (updatedIds.length > 0) {
          getSocketsForUser(sender).forEach(sock => sendJson(sock, { type: 'messages_read_by_partner', partner: currentUsername, messageIds: updatedIds }));
        }
      }
      return;
    }
  });

  const handleDisconnect = () => {
    const info = socketUserMap.get(ws);
    if (!info) return;
    socketUserMap.delete(ws);
    if (info.username) {
      db.updateUserLastSeen(info.username);
      if (getSocketsForUser(info.username).length === 0) {
        broadcast({ type: 'system_event', event: 'user_left', username: info.username, text: `${info.username} disconnected`, timestamp: Date.now() });
        broadcastRoster();
      }
    }
  };

  ws.on('close', handleDisconnect);
  ws.on('error', handleDisconnect);
});

// Heartbeat
const heartbeat = setInterval(() => {
  for (const [ws, info] of socketUserMap.entries()) {
    if (!info.alive) { ws.terminate(); socketUserMap.delete(ws); continue; }
    info.alive = false;
    try { ws.ping(); } catch { ws.terminate(); socketUserMap.delete(ws); }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.maxConnections = 50000;
server.keepAliveTimeout = 70000;
server.headersTimeout = 75000;

server.listen(PORT, '0.0.0.0', 4096, () => {
  console.log(`====================================================`);
  console.log(`🚀 WaveTalk [${INSTANCE_ID}] running on port ${PORT}`);
  console.log(`📬 POST /message  — submit a message`);
  console.log(`📋 GET  /feed     — retrieve all messages`);
  console.log(`📊 GET  /api/metrics — live metrics for LB`);
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const alias of (iface||[])) {
      if (alias.family === 'IPv4' && !alias.internal) console.log(`🌐 http://${alias.address}:${PORT}`);
    }
  }
  console.log(`====================================================`);
});
