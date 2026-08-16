// WaveTalk Real-Time Chat Server
// Features: HTTP static file server, WebSocket real-time messaging, Group Chat,
// Encrypted Direct Messages routing, User Presence, Join Timestamps, and Persistent Database.

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

// MIME types dictionary for static file serving
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

// HTTP Server
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = urlObj.pathname;

  // API Endpoints
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
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

  // Serve static files
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  // Security check: ensure file is inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA if not an asset request
      if (!path.extname(pathname)) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(indexPath, (readErr, content) => {
          if (readErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found');
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// WebSocket Server
const wss = new WebSocketServer({ server });

// Map WebSocket to user metadata: ws -> { username, joinedAt, alive }
const socketUserMap = new Map();

// Helper functions
function getOnlineUsernames() {
  const online = new Set();
  for (const [ws, info] of socketUserMap.entries()) {
    if (ws.readyState === ws.OPEN && info.username) {
      online.add(info.username.toLowerCase());
    }
  }
  return [...online];
}

function getSocketsForUser(username) {
  const lower = (username || '').toLowerCase();
  const sockets = [];
  for (const [ws, info] of socketUserMap.entries()) {
    if (ws.readyState === ws.OPEN && info.username && info.username.toLowerCase() === lower) {
      sockets.push(ws);
    }
  }
  return sockets;
}

function getRosterWithStatus() {
  const onlineSet = new Set(getOnlineUsernames());
  const allUsers = db.getAllUsers();
  return allUsers.map(u => ({
    username: u.username,
    joinedAt: u.joinedAt,
    lastSeen: u.lastSeen,
    avatarColor: u.avatarColor,
    isOnline: onlineSet.has(u.username.toLowerCase())
  })).sort((a, b) => {
    // Online users first, then by username
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error('[WS] Send error:', e.message);
    }
  }
}

function broadcast(obj, excludeWs = null) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== excludeWs && client.readyState === client.OPEN) {
      try {
        client.send(payload);
      } catch (e) {
        console.error('[WS] Broadcast error:', e.message);
      }
    }
  }
}

function broadcastRoster() {
  const roster = getRosterWithStatus();
  broadcast({ type: 'roster_update', roster, onlineCount: getOnlineUsernames().length });
}

// WebSocket Event Handling
wss.on('connection', (ws, req) => {
  const clientInfo = { username: null, alive: true, ip: req.socket.remoteAddress };
  socketUserMap.set(ws, clientInfo);

  ws.on('pong', () => {
    clientInfo.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
    }

    const { type, payload } = msg;

    // --- AUTH / JOIN ---
    if (type === 'auth_join') {
      const { username, pin } = payload || {};

      try {
        const authResult = db.getOrCreateUser(username, pin);

        if (authResult.error) {
          return sendJson(ws, {
            type: 'auth_error',
            reason: authResult.error,
            username: authResult.username
          });
        }

        const user = authResult.user;
        clientInfo.username = user.username;
        clientInfo.joinedAt = user.joinedAt;

        // Fetch history & initial state
        // New users see no previous chat history. Returning users see their chat history from their joinedAt timestamp onwards.
        const groupHistory = authResult.isNew ? [] : db.getGroupHistory(100, user.joinedAt);
        const personalConversations = db.getAllPersonalConversationsForUser(user.username);
        const roster = getRosterWithStatus();

        sendJson(ws, {
          type: 'auth_success',
          user: {
            username: user.username,
            joinedAt: user.joinedAt,
            avatarColor: user.avatarColor,
            isNew: authResult.isNew
          },
          groupHistory,
          personalConversations,
          roster
        });

        // Broadcast join notice
        broadcast({
          type: 'system_event',
          event: 'user_joined',
          username: user.username,
          joinedAt: user.joinedAt,
          text: `${user.username} joined the chat`,
          timestamp: Date.now()
        }, ws);

        // Update roster across all clients
        broadcastRoster();
        console.log(`[AUTH] ${user.username} joined (New: ${authResult.isNew}). Online: ${getOnlineUsernames().length}`);
      } catch (err) {
        sendJson(ws, { type: 'auth_error', reason: err.message });
      }
      return;
    }

    // Require authentication for subsequent actions
    if (!clientInfo.username) {
      return sendJson(ws, { type: 'auth_required', message: 'Please log in first' });
    }

    const currentUsername = clientInfo.username;
    db.updateUserLastSeen(currentUsername);

    // --- GROUP CHAT MESSAGE ---
    if (type === 'chat_group') {
      const text = String(payload?.text || '').trim();
      if (!text) return;

      const savedMsg = db.saveGroupMessage({
        sender: currentUsername,
        text: text.slice(0, 2000),
        type: 'chat'
      });

      broadcast({
        type: 'group_message',
        message: savedMsg
      });

      console.log(`[GROUP] ${currentUsername}: ${text.slice(0, 60)}`);
      return;
    }

    // --- ENCRYPTED PERSONAL / DIRECT MESSAGE ---
    if (type === 'chat_personal') {
      const { recipient, ciphertext, iv, salt, meta } = payload || {};
      if (!recipient || !ciphertext || !iv) {
        return sendJson(ws, { type: 'error', message: 'Incomplete encrypted message' });
      }

      const recipientUser = db.getUser(recipient);
      if (!recipientUser) {
        return sendJson(ws, { type: 'error', message: `User ${recipient} does not exist.` });
      }

      const savedMsg = db.savePersonalMessage({
        sender: currentUsername,
        recipient: recipientUser.username,
        ciphertext,
        iv,
        salt: salt || '',
        meta: meta || {}
      });

      // Send to all active sockets of the recipient
      const recipientSockets = getSocketsForUser(recipientUser.username);
      recipientSockets.forEach(sock => {
        sendJson(sock, {
          type: 'personal_message',
          message: savedMsg
        });
      });

      // Send confirmation / echo to all active sockets of the sender
      const senderSockets = getSocketsForUser(currentUsername);
      senderSockets.forEach(sock => {
        sendJson(sock, {
          type: 'personal_message_sent',
          message: savedMsg
        });
      });

      console.log(`[PM Encrypted] ${currentUsername} -> ${recipientUser.username} (bytes: ${ciphertext.length})`);
      return;
    }

    // --- FETCH PERSONAL CHAT HISTORY ---
    if (type === 'get_personal_history') {
      const { partner } = payload || {};
      if (!partner) return;

      const history = db.getPersonalHistory(currentUsername, partner, 100);
      db.markPersonalMessagesAsRead(currentUsername, partner);

      sendJson(ws, {
        type: 'personal_history',
        partner,
        history
      });
      return;
    }

    // --- TYPING INDICATOR ---
    if (type === 'typing') {
      const { target, isTyping } = payload || {};
      if (target === 'group') {
        broadcast({
          type: 'typing_update',
          target: 'group',
          username: currentUsername,
          isTyping: !!isTyping
        }, ws);
      } else if (target) {
        const recipientSockets = getSocketsForUser(target);
        recipientSockets.forEach(sock => {
          sendJson(sock, {
            type: 'typing_update',
            target: 'personal',
            sender: currentUsername,
            isTyping: !!isTyping
          });
        });
      }
      return;
    }

    // --- MARK READ ---
    if (type === 'mark_read') {
      const { sender } = payload || {};
      if (sender) {
        db.markPersonalMessagesAsRead(currentUsername, sender);
        sendJson(ws, { type: 'marked_read_ok', sender });
      }
      return;
    }
  });

  // Disconnect handler
  const handleDisconnect = () => {
    const info = socketUserMap.get(ws);
    if (!info) return;

    socketUserMap.delete(ws);

    if (info.username) {
      db.updateUserLastSeen(info.username);
      const remainingSockets = getSocketsForUser(info.username);

      // Only announce departure if user has no remaining active connections
      if (remainingSockets.length === 0) {
        broadcast({
          type: 'system_event',
          event: 'user_left',
          username: info.username,
          text: `${info.username} disconnected`,
          timestamp: Date.now()
        });
        broadcastRoster();
        console.log(`[AUTH] ${info.username} left. Online: ${getOnlineUsernames().length}`);
      }
    }
  };

  ws.on('close', handleDisconnect);
  ws.on('error', handleDisconnect);
});

// Heartbeat interval to drop dead connections
const heartbeat = setInterval(() => {
  for (const [ws, info] of socketUserMap.entries()) {
    if (!info.alive) {
      ws.terminate();
      socketUserMap.delete(ws);
      continue;
    }
    info.alive = false;
    try {
      ws.ping();
    } catch (err) {
      ws.terminate();
      socketUserMap.delete(ws);
    }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 WaveTalk Chat Server running on port ${PORT}`);
  console.log(`💻 Local:   http://localhost:${PORT}`);

  const networkInterfaces = os.networkInterfaces();
  for (const iface of Object.values(networkInterfaces)) {
    if (!iface) continue;
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        console.log(`🌐 Network: http://${alias.address}:${PORT}`);
      }
    }
  }
  console.log(`====================================================`);
});