// Database Manager with atomic file-backed JSON storage
// Handles users, group messages, encrypted personal messages, and join timestamps.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'chat_database.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class ChatDatabase {
  constructor(filePath = DEFAULT_DB_FILE) {
    this.dbFile = filePath;
    this.data = {
      users: {},           // username -> { id, username, pinHash, salt, joinedAt, lastSeen, avatarColor }
      groupMessages: [],   // [ { id, sender, text, timestamp, type } ]
      personalMessages: [] // [ { id, sender, recipient, ciphertext, iv, salt, timestamp, read } ]
    };
    this.isSaving = false;
    this.pendingSave = false;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dbFile)) {
        const raw = fs.readFileSync(this.dbFile, 'utf-8');
        const parsed = JSON.parse(raw);
        this.data = {
          users: parsed.users || {},
          groupMessages: parsed.groupMessages || [],
          personalMessages: parsed.personalMessages || []
        };
        console.log(`[DB] Loaded ${Object.keys(this.data.users).length} users, ${this.data.groupMessages.length} group msgs, ${this.data.personalMessages.length} private msgs.`);
      } else {
        this.saveSync();
      }
    } catch (err) {
      console.error('[DB] Error loading database, initializing fresh:', err.message);
      this.saveSync();
    }
  }

  saveSync() {
    try {
      const tempFile = `${this.dbFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempFile, this.dbFile);
    } catch (err) {
      console.error('[DB] Failed to save synchronously:', err);
    }
  }

  scheduleSave() {
    if (this.isSaving) {
      this.pendingSave = true;
      return;
    }
    this.isSaving = true;
    setTimeout(() => {
      try {
        const tempFile = `${this.dbFile}.tmp.${Date.now()}`;
        fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf-8');
        fs.renameSync(tempFile, this.dbFile);
      } catch (err) {
        console.error('[DB] Error saving data:', err);
      } finally {
        this.isSaving = false;
        if (this.pendingSave) {
          this.pendingSave = false;
          this.scheduleSave();
        }
      }
    }, 100);
  }

  // --- User Operations ---

  hashPin(pin, salt) {
    return crypto.pbkdf2Sync(pin, salt, 10000, 32, 'sha256').toString('hex');
  }

  generateAvatarColor(name) {
    const palette = [
      { bg: '#2563eb', fg: '#ffffff' }, // Blue
      { bg: '#059669', fg: '#ffffff' }, // Emerald
      { bg: '#7c3aed', fg: '#ffffff' }, // Violet
      { bg: '#d97706', fg: '#ffffff' }, // Amber
      { bg: '#db2777', fg: '#ffffff' }, // Pink
      { bg: '#0891b2', fg: '#ffffff' }, // Cyan
      { bg: '#ea580c', fg: '#ffffff' }, // Orange
      { bg: '#0d9488', fg: '#ffffff' }, // Teal
      { bg: '#4f46e5', fg: '#ffffff' }  // Indigo
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  getOrCreateUser(rawUsername, pin = '') {
    const cleanName = (rawUsername || '').trim();
    if (!cleanName || cleanName.length < 2) {
      throw new Error('Username must be at least 2 characters.');
    }
    if (cleanName.length > 24) {
      throw new Error('Username must be 24 characters or less.');
    }

    const key = cleanName.toLowerCase();
    const existing = this.data.users[key];
    const now = Date.now();

    if (existing) {
      // If user set a PIN previously, verify it
      if (existing.pinHash) {
        if (!pin) {
          return { error: 'PIN_REQUIRED', username: existing.username };
        }
        const verify = this.hashPin(pin, existing.salt);
        if (verify !== existing.pinHash) {
          return { error: 'INVALID_PIN', username: existing.username };
        }
      } else if (pin) {
        // Set PIN for existing user
        const salt = crypto.randomBytes(16).toString('hex');
        existing.salt = salt;
        existing.pinHash = this.hashPin(pin, salt);
      }

      existing.lastSeen = now;
      this.scheduleSave();
      return { success: true, user: existing, isNew: false };
    }

    // Create new user
    let salt = null;
    let pinHash = null;
    if (pin) {
      salt = crypto.randomBytes(16).toString('hex');
      pinHash = this.hashPin(pin, salt);
    }

    const newUser = {
      id: `usr_${crypto.randomUUID().slice(0, 8)}`,
      username: cleanName,
      pinHash,
      salt,
      joinedAt: now,
      lastSeen: now,
      avatarColor: this.generateAvatarColor(cleanName)
    };

    this.data.users[key] = newUser;
    this.scheduleSave();
    return { success: true, user: newUser, isNew: true };
  }

  updateUserLastSeen(username) {
    const key = (username || '').trim().toLowerCase();
    if (this.data.users[key]) {
      this.data.users[key].lastSeen = Date.now();
      this.scheduleSave();
    }
  }

  getUser(username) {
    const key = (username || '').trim().toLowerCase();
    return this.data.users[key] || null;
  }

  getAllUsers() {
    return Object.values(this.data.users).map(u => ({
      username: u.username,
      joinedAt: u.joinedAt,
      lastSeen: u.lastSeen,
      avatarColor: u.avatarColor
    }));
  }

  // --- Group Messages Operations ---

  saveGroupMessage({ sender, text, type = 'chat', meta = {} }) {
    const msg = {
      id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sender,
      text: String(text || '').trim(),
      type,
      meta,
      timestamp: Date.now()
    };
    this.data.groupMessages.push(msg);

    // Keep up to 2000 recent group messages
    if (this.data.groupMessages.length > 2000) {
      this.data.groupMessages = this.data.groupMessages.slice(-2000);
    }

    this.scheduleSave();
    return msg;
  }

  getGroupHistory(limit = 100, sinceTimestamp = 0) {
    let list = this.data.groupMessages;
    if (sinceTimestamp > 0) {
      list = list.filter(m => m.timestamp >= sinceTimestamp);
    }
    return list.slice(-limit);
  }

  // --- Personal Messages (Encrypted) Operations ---

  savePersonalMessage({ sender, recipient, ciphertext, iv, salt, meta = {} }) {
    if (!sender || !recipient || !ciphertext || !iv) {
      throw new Error('Incomplete encrypted message payload');
    }

    const msg = {
      id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sender,
      recipient,
      ciphertext,
      iv,
      salt: salt || '',
      meta,
      read: false,
      timestamp: Date.now()
    };

    this.data.personalMessages.push(msg);

    // Keep up to 5000 recent personal messages
    if (this.data.personalMessages.length > 5000) {
      this.data.personalMessages = this.data.personalMessages.slice(-5000);
    }

    this.scheduleSave();
    return msg;
  }

  getPersonalHistory(user1, user2, limit = 100) {
    const u1 = (user1 || '').toLowerCase();
    const u2 = (user2 || '').toLowerCase();

    return this.data.personalMessages
      .filter(m => {
        const s = m.sender.toLowerCase();
        const r = m.recipient.toLowerCase();
        return (s === u1 && r === u2) || (s === u2 && r === u1);
      })
      .slice(-limit);
  }

  getAllPersonalConversationsForUser(username) {
    const u = (username || '').toLowerCase();
    const map = {};

    for (const msg of this.data.personalMessages) {
      const isSender = msg.sender.toLowerCase() === u;
      const isRecipient = msg.recipient.toLowerCase() === u;
      if (!isSender && !isRecipient) continue;

      const partner = isSender ? msg.recipient : msg.sender;
      const partnerKey = partner.toLowerCase();

      if (!map[partnerKey]) {
        map[partnerKey] = {
          partner,
          lastMessageAt: msg.timestamp,
          unreadCount: 0,
          totalMessages: 0
        };
      }

      map[partnerKey].lastMessageAt = Math.max(map[partnerKey].lastMessageAt, msg.timestamp);
      map[partnerKey].totalMessages++;
      if (isRecipient && !msg.read) {
        map[partnerKey].unreadCount++;
      }
    }

    return Object.values(map).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  markPersonalMessagesAsRead(recipient, sender) {
    const r = (recipient || '').toLowerCase();
    const s = (sender || '').toLowerCase();
    let updated = false;

    for (const msg of this.data.personalMessages) {
      if (msg.recipient.toLowerCase() === r && msg.sender.toLowerCase() === s && !msg.read) {
        msg.read = true;
        updated = true;
      }
    }

    if (updated) {
      this.scheduleSave();
    }
  }
}

export const db = new ChatDatabase();
