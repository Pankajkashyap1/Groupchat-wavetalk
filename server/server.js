import 'dotenv/config';
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
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/CHAT-APP';

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

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = urlObj.pathname;

  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const allUsers = await db.getAllUsers();
    return res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      onlineUsers: getOnlineUsernames().length,
      totalUsers: allUsers.length,
      timestamp: Date.now()
    }));
  }

  if (pathname === '/api/users') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const roster = await getRosterWithStatus();
    return res.end(JSON.stringify(roster));
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
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

const wss = new WebSocketServer({ server });
const socketUserMap = new Map();

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

async function getRosterWithStatus() {
  const onlineSet = new Set(getOnlineUsernames());
  const allUsers = await db.getAllUsers();
  return allUsers.map(u => ({
    username: u.username,
    joinedAt: u.joinedAt,
    lastSeen: u.lastSeen,
    avatarColor: u.avatarColor,
    isOnline: onlineSet.has(u.username.toLowerCase())
  })).sort((a, b) => {
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

async function broadcastRoster() {
  const roster = await getRosterWithStatus();
  broadcast({ type: 'roster_update', roster, onlineCount: getOnlineUsernames().length });
}

wss.on('connection', (ws, req) => {
  const clientInfo = { username: null, alive: true, ip: req.socket.remoteAddress };
  socketUserMap.set(ws, clientInfo);

  ws.on('pong', () => {
    clientInfo.alive = true;
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
    }

    const { type, payload } = msg;

    try {
      if (type === 'auth_join') {
        const { username, pin } = payload || {};
        const authResult = await db.getOrCreateUser(username, pin);

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

        const groupHistory = authResult.isNew ? [] : await db.getGroupHistory(100, user.joinedAt);
        const personalConversations = await db.getAllPersonalConversationsForUser(user.username);
        const roster = await getRosterWithStatus();

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

        broadcast({
          type: 'system_event',
          event: 'user_joined',
          username: user.username,
          joinedAt: user.joinedAt,
          text: `${user.username} joined the chat`,
          timestamp: Date.now()
        }, ws);

        await broadcastRoster();
        console.log(`[AUTH] ${user.username} joined (New: ${authResult.isNew}). Online: ${getOnlineUsernames().length}`);
        return;
      }

      if (!clientInfo.username) {
        return sendJson(ws, { type: 'auth_required', message: 'Please log in first' });
      }

      const currentUsername = clientInfo.username;
      
      db.updateUserLastSeen(currentUsername).catch(console.error);

      if (type === 'chat_group') {
        const text = String(payload?.text || '').trim();
        if (!text) return;

        const savedMsg = await db.saveGroupMessage({
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

      if (type === 'chat_personal') {
        const { recipient, ciphertext, iv, salt, meta } = payload || {};
        if (!recipient || !ciphertext || !iv) {
          return sendJson(ws, { type: 'error', message: 'Incomplete encrypted message' });
        }

        const recipientUser = await db.getUser(recipient);
        if (!recipientUser) {
          return sendJson(ws, { type: 'error', message: `User ${recipient} does not exist.` });
        }

        const savedMsg = await db.savePersonalMessage({
          sender: currentUsername,
          recipient: recipientUser.username,
          ciphertext,
          iv,
          salt: salt || '',
          meta: meta || {}
        });

        const recipientSockets = getSocketsForUser(recipientUser.username);
        recipientSockets.forEach(sock => {
          sendJson(sock, {
            type: 'personal_message',
            message: savedMsg
          });
        });

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

      if (type === 'get_personal_history') {
        const { partner } = payload || {};
        if (!partner) return;

        const history = await db.getPersonalHistory(currentUsername, partner, 100);
        await db.markPersonalMessagesAsRead(currentUsername, partner);

        sendJson(ws, {
          type: 'personal_history',
          partner,
          history
        });
        return;
      }

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

      if (type === 'mark_read') {
        const { sender } = payload || {};
        if (sender) {
          await db.markPersonalMessagesAsRead(currentUsername, sender);
          sendJson(ws, { type: 'marked_read_ok', sender });
        }
        return;
      }
    } catch (error) {
      console.error(`[WS Error] Handling ${type}:`, error);
      sendJson(ws, { type: 'error', message: 'Internal server error' });
    }
  });

  const handleDisconnect = async () => {
    const info = socketUserMap.get(ws);
    if (!info) return;

    socketUserMap.delete(ws);

    if (info.username) {
      try {
        await db.updateUserLastSeen(info.username);
      } catch (e) {
        console.error('Failed to update last seen on disconnect:', e);
      }
      
      const remainingSockets = getSocketsForUser(info.username);

      if (remainingSockets.length === 0) {
        broadcast({
          type: 'system_event',
          event: 'user_left',
          username: info.username,
          text: `${info.username} disconnected`,
          timestamp: Date.now()
        });
        await broadcastRoster();
        console.log(`[AUTH] ${info.username} left. Online: ${getOnlineUsernames().length}`);
      }
    }
  };

  ws.on('close', handleDisconnect);
  ws.on('error', handleDisconnect);
});

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

async function startServer() {
  try {
    await db.connectDB(MONGODB_URI);
    
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
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();