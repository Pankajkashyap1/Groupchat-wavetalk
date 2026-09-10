// Database Manager with atomic file-backed JSON storage
// Ultra-optimized for high-concurrency evaluation (20,000 requests)
// Features: In-memory O(1) deduplication, debounced compact disk commits, mtime reload check.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'chat_database.json');

if (!process.env.DB_FILE && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (process.env.DB_FILE) {
  const d = path.dirname(process.env.DB_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

export class ChatDatabase {
  constructor(filePath = DEFAULT_DB_FILE) {
    this.dbFile = filePath;
    this.data = { users: {}, groupMessages: [], personalMessages: [] };
    this.messageIdIndex = new Set();
    this.lastLoadedMtime = 0;
    this.lastCheckReload = 0;
    this.isSaving = false;
    this.pendingSave = false;
    this.saveTimeout = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dbFile)) {
        const stats = fs.statSync(this.dbFile);
        const parsed = JSON.parse(fs.readFileSync(this.dbFile, 'utf-8'));
        this.data = {
          users: parsed.users || {},
          groupMessages: parsed.groupMessages || [],
          personalMessages: parsed.personalMessages || []
        };
        this.messageIdIndex = new Set([
          ...this.data.groupMessages.map(m => m.id),
          ...this.data.personalMessages.map(m => m.id)
        ]);
        this.lastLoadedMtime = stats.mtimeMs;
      } else {
        this.saveSync();
      }
    } catch (err) {
      console.error('[DB] Load error:', err.message);
      this.saveSync();
    }
  }

  checkReload() {
    const now = Date.now();
    // Only check file stats at most once every 500ms to keep throughput maximum
    if (now - this.lastCheckReload < 500) return;
    this.lastCheckReload = now;

    try {
      if (fs.existsSync(this.dbFile)) {
        const stats = fs.statSync(this.dbFile);
        if (stats.mtimeMs > this.lastLoadedMtime) {
          this.load();
        }
      }
    } catch (e) {}
  }

  saveSync() {
    try {
      const dir = path.dirname(this.dbFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.dbFile}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf-8');
      fs.renameSync(tmp, this.dbFile);
      const stats = fs.statSync(this.dbFile);
      this.lastLoadedMtime = stats.mtimeMs;
    } catch (err) {
      console.error('[DB] saveSync failed:', err);
    }
  }

  scheduleSave() {
    if (this.saveTimeout) return; // already scheduled
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      try {
        const tmp = `${this.dbFile}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf-8');
        fs.renameSync(tmp, this.dbFile);
        const stats = fs.statSync(this.dbFile);
        this.lastLoadedMtime = stats.mtimeMs;
      } catch (err) {
        console.error('[DB] Save error:', err);
      }
    }, 1000); // Batched 1-second compact flush
  }

  hashPin(pin, salt) {
    return crypto.pbkdf2Sync(pin, salt, 10000, 32, 'sha256').toString('hex');
  }

  generateAvatarColor(name) {
    const palette = [
      '#2563eb','#059669','#7c3aed','#d97706','#db2777','#0891b2','#ea580c','#0d9488','#4f46e5'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return { bg: palette[Math.abs(hash) % palette.length], fg: '#ffffff' };
  }

  getOrCreateUser(rawUsername, pin = '') {
    this.checkReload();
    const cleanName = (rawUsername || '').trim();
    if (!cleanName || cleanName.length < 2) throw new Error('Username must be at least 2 characters.');
    if (cleanName.length > 24) throw new Error('Username must be 24 characters or less.');
    const key = cleanName.toLowerCase();
    const existing = this.data.users[key];
    const now = Date.now();
    if (existing) {
      if (existing.pinHash) {
        if (!pin) return { error: 'PIN_REQUIRED', username: existing.username };
        if (this.hashPin(pin, existing.salt) !== existing.pinHash) return { error: 'INVALID_PIN', username: existing.username };
      } else if (pin) {
        const salt = crypto.randomBytes(16).toString('hex');
        existing.salt = salt;
        existing.pinHash = this.hashPin(pin, salt);
      }
      existing.lastSeen = now;
      this.scheduleSave();
      return { success: true, user: existing, isNew: false };
    }
    let salt = null, pinHash = null;
    if (pin) { salt = crypto.randomBytes(16).toString('hex'); pinHash = this.hashPin(pin, salt); }
    const newUser = { id: `usr_${crypto.randomUUID().slice(0,8)}`, username: cleanName, pinHash, salt, joinedAt: now, lastSeen: now, avatarColor: this.generateAvatarColor(cleanName) };
    this.data.users[key] = newUser;
    this.scheduleSave();
    return { success: true, user: newUser, isNew: true };
  }

  updateUserLastSeen(username) {
    const key = (username || '').trim().toLowerCase();
    if (this.data.users[key]) { this.data.users[key].lastSeen = Date.now(); this.scheduleSave(); }
  }

  getUser(username) {
    this.checkReload();
    return this.data.users[(username || '').trim().toLowerCase()] || null;
  }

  getAllUsers() {
    this.checkReload();
    return Object.values(this.data.users).map(u => ({ username: u.username, joinedAt: u.joinedAt, lastSeen: u.lastSeen, avatarColor: u.avatarColor }));
  }

  // --- Group Messages Operations ---

  saveGroupMessage({ id, sender, text, type = 'chat', meta = {} }) {
    this.checkReload();
    const cleanText = String(text || '').trim();

    // Idempotent: check if message ID exists
    if (id && this.messageIdIndex.has(id)) {
      const existing = this.data.groupMessages.find(m => m.id === id);
      return existing || { id, sender, text: cleanText, type, timestamp: Date.now(), duplicate: true };
    }

    const msgId = id || `grp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const msg = { id: msgId, sender, text: cleanText, type, meta, timestamp: Date.now() };

    this.messageIdIndex.add(msgId);
    this.data.groupMessages.push(msg);

    if (this.data.groupMessages.length > 50000) {
      this.data.groupMessages.splice(0, this.data.groupMessages.length - 50000).forEach(m => this.messageIdIndex.delete(m.id));
    }
    this.scheduleSave();
    return msg;
  }

  getGroupHistory(limit = 100, sinceTimestamp = 0) {
    this.checkReload();
    let list = this.data.groupMessages;
    if (sinceTimestamp > 0) list = list.filter(m => m.timestamp >= sinceTimestamp);
    return list.slice(-limit);
  }

  // /feed API format: [{ id, sender, msg, timestamp }]
  getPublicFeed() {
    this.checkReload();
    return this.data.groupMessages.map(m => ({
      id: m.id,
      sender: m.sender,
      msg: m.text,
      timestamp: m.timestamp
    }));
  }

  // --- Personal Messages Operations ---

  savePersonalMessage({ id, sender, recipient, ciphertext, iv, salt, meta = {} }) {
    this.checkReload();
    if (!sender || !recipient || !ciphertext || !iv) throw new Error('Incomplete encrypted message payload');
    if (id && this.messageIdIndex.has(id)) return this.data.personalMessages.find(m => m.id === id) || { id, duplicate: true };
    const msgId = id || `pm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const msg = { id: msgId, sender, recipient, ciphertext, iv, salt: salt || '', meta, read: false, timestamp: Date.now() };
    this.messageIdIndex.add(msgId);
    this.data.personalMessages.push(msg);
    if (this.data.personalMessages.length > 10000) {
      this.data.personalMessages.splice(0, this.data.personalMessages.length - 10000).forEach(m => this.messageIdIndex.delete(m.id));
    }
    this.scheduleSave();
    return msg;
  }

  getPersonalHistory(user1, user2, limit = 100) {
    this.checkReload();
    const u1 = (user1||'').toLowerCase(), u2 = (user2||'').toLowerCase();
    return this.data.personalMessages.filter(m => {
      const s = m.sender.toLowerCase(), r = m.recipient.toLowerCase();
      return (s===u1&&r===u2)||(s===u2&&r===u1);
    }).slice(-limit);
  }

  getAllPersonalConversationsForUser(username) {
    this.checkReload();
    const u = (username||'').toLowerCase(), map = {};
    for (const msg of this.data.personalMessages) {
      const isSender = msg.sender.toLowerCase()===u, isRecipient = msg.recipient.toLowerCase()===u;
      if (!isSender&&!isRecipient) continue;
      const partner = isSender ? msg.recipient : msg.sender, pk = partner.toLowerCase();
      if (!map[pk]) map[pk] = { partner, lastMessageAt: msg.timestamp, unreadCount: 0, totalMessages: 0 };
      map[pk].lastMessageAt = Math.max(map[pk].lastMessageAt, msg.timestamp);
      map[pk].totalMessages++;
      if (isRecipient&&!msg.read) map[pk].unreadCount++;
    }
    return Object.values(map).sort((a,b) => b.lastMessageAt-a.lastMessageAt);
  }

  markPersonalMessagesAsRead(recipient, sender) {
    this.checkReload();
    const r = (recipient||'').toLowerCase(), s = (sender||'').toLowerCase(), ids = [];
    for (const msg of this.data.personalMessages) {
      if (msg.recipient.toLowerCase()===r&&msg.sender.toLowerCase()===s&&!msg.read) { msg.read=true; ids.push(msg.id); }
    }
    if (ids.length>0) this.scheduleSave();
    return ids;
  }
}

export const db = new ChatDatabase();
