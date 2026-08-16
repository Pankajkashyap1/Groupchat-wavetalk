// End-to-End WebSocket Integration Test with Isolated Test Database
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { ChatDatabase } from '../server/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_E2E_DB_FILE = path.join(__dirname, '..', 'data', 'temp_e2e_test.json');

// Cleanup old test file
if (fs.existsSync(TEST_E2E_DB_FILE)) fs.unlinkSync(TEST_E2E_DB_FILE);

const testDb = new ChatDatabase(TEST_E2E_DB_FILE);
const TEST_PORT = 3456;

function createTestServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('OK');
  });

  const wss = new WebSocketServer({ server });
  const socketUserMap = new Map();

  function getSocketsForUser(username) {
    const list = [];
    for (const [ws, info] of socketUserMap) {
      if (ws.readyState === ws.OPEN && info.username?.toLowerCase() === username.toLowerCase()) {
        list.push(ws);
      }
    }
    return list;
  }

  function sendJson(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function broadcast(obj, exclude) {
    for (const client of wss.clients) {
      if (client !== exclude && client.readyState === client.OPEN) {
        client.send(JSON.stringify(obj));
      }
    }
  }

  wss.on('connection', (ws) => {
    const info = { username: null };
    socketUserMap.set(ws, info);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const { type, payload } = msg;

      if (type === 'auth_join') {
        const auth = testDb.getOrCreateUser(payload.username, payload.pin);
        info.username = auth.user.username;
        sendJson(ws, {
          type: 'auth_success',
          user: auth.user,
          groupHistory: testDb.getGroupHistory(50),
          personalConversations: testDb.getAllPersonalConversationsForUser(auth.user.username)
        });
        broadcast({
          type: 'system_event',
          text: `${auth.user.username} joined`,
          joinedAt: auth.user.joinedAt
        }, ws);
      }

      if (type === 'chat_group' && info.username) {
        const saved = testDb.saveGroupMessage({ sender: info.username, text: payload.text });
        broadcast({ type: 'group_message', message: saved });
      }

      if (type === 'chat_personal' && info.username) {
        const saved = testDb.savePersonalMessage({
          sender: info.username,
          recipient: payload.recipient,
          ciphertext: payload.ciphertext,
          iv: payload.iv
        });
        getSocketsForUser(payload.recipient).forEach(s => sendJson(s, { type: 'personal_message', message: saved }));
        getSocketsForUser(info.username).forEach(s => sendJson(s, { type: 'personal_message_sent', message: saved }));
      }

      if (type === 'get_personal_history' && info.username) {
        const hist = testDb.getPersonalHistory(info.username, payload.partner);
        sendJson(ws, { type: 'personal_history', partner: payload.partner, history: hist });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(TEST_PORT, () => resolve({ server, wss }));
  });
}

function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
    const messages = [];

    ws.on('open', () => resolve({ ws, messages }));
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('error', reject);
  });
}

function waitForMessage(client, filterFn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = client.messages.find(filterFn);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error('Timeout waiting for message'));
      setTimeout(check, 50);
    };
    check();
  });
}

test('E2E: Real-time Multi-client Join, Timestamps, Group & Encrypted Chat, Persistence on Reconnect', async (t) => {
  const { server, wss } = await createTestServer();

  try {
    // 1. Client A connects
    const clientA = await createClient();
    clientA.ws.send(JSON.stringify({
      type: 'auth_join',
      payload: { username: 'TestUser_A' }
    }));

    const authA = await waitForMessage(clientA, m => m.type === 'auth_success');
    assert.equal(authA.user.username, 'TestUser_A');
    assert.ok(authA.user.joinedAt > 0);

    // 2. Client B connects
    const clientB = await createClient();
    clientB.ws.send(JSON.stringify({
      type: 'auth_join',
      payload: { username: 'TestUser_B' }
    }));

    const authB = await waitForMessage(clientB, m => m.type === 'auth_success');
    assert.equal(authB.user.username, 'TestUser_B');

    // Verify Client A receives system event
    const joinNotice = await waitForMessage(clientA, m => m.type === 'system_event' && m.text.includes('TestUser_B'));
    assert.ok(joinNotice);
    assert.ok(joinNotice.joinedAt > 0);

    // 3. Client A sends group message
    clientA.ws.send(JSON.stringify({
      type: 'chat_group',
      payload: { text: 'Hello IIT Bhilai!' }
    }));

    const groupMsg = await waitForMessage(clientB, m => m.type === 'group_message');
    assert.equal(groupMsg.message.sender, 'TestUser_A');
    assert.equal(groupMsg.message.text, 'Hello IIT Bhilai!');
    assert.ok(groupMsg.message.timestamp > 0);

    // 4. Client B sends encrypted direct message
    clientB.ws.send(JSON.stringify({
      type: 'chat_personal',
      payload: {
        recipient: 'TestUser_A',
        ciphertext: 'e2e_ciphertext_secret_data',
        iv: 'iv_random_vector'
      }
    }));

    const pmRecv = await waitForMessage(clientA, m => m.type === 'personal_message');
    assert.equal(pmRecv.message.sender, 'TestUser_B');
    assert.equal(pmRecv.message.recipient, 'TestUser_A');
    assert.equal(pmRecv.message.ciphertext, 'e2e_ciphertext_secret_data');

    // 5. Client A disconnects and reconnects
    clientA.ws.close();

    const clientAReconnected = await createClient();
    clientAReconnected.ws.send(JSON.stringify({
      type: 'auth_join',
      payload: { username: 'TestUser_A' }
    }));

    const reAuth = await waitForMessage(clientAReconnected, m => m.type === 'auth_success');
    assert.equal(reAuth.user.username, 'TestUser_A');
    assert.ok(reAuth.groupHistory.some(m => m.text === 'Hello IIT Bhilai!'));

    clientB.ws.close();
    clientAReconnected.ws.close();
  } finally {
    server.close();
    wss.close();
    if (fs.existsSync(TEST_E2E_DB_FILE)) fs.unlinkSync(TEST_E2E_DB_FILE);
  }
});
