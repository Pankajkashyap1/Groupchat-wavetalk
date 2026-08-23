import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export class ChatDatabase {
  constructor() {
    this.client = null;
    this.db = null;
    this.usersCollection = null;
    this.groupMessagesCollection = null;
    this.personalMessagesCollection = null;
  }

  async connectDB(uri) {
    if (!uri) throw new Error("MongoDB URI is required");
    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db();

    this.usersCollection = this.db.collection('users');
    this.groupMessagesCollection = this.db.collection('messages_group');
    this.personalMessagesCollection = this.db.collection('messages_personal');

    await this.usersCollection.createIndex({ username: 1 }, { unique: true });
    await this.groupMessagesCollection.createIndex({ timestamp: 1 });
    await this.personalMessagesCollection.createIndex({ sender: 1, recipient: 1, timestamp: 1 });
    await this.personalMessagesCollection.createIndex({ recipient: 1, read: 1 });

    console.log('[DB] Connected to MongoDB and ensured indexes.');
  }

  generateAvatarColor(name) {
    const palette = [
      { bg: '#2563eb', fg: '#ffffff' }, { bg: '#059669', fg: '#ffffff' },
      { bg: '#7c3aed', fg: '#ffffff' }, { bg: '#d97706', fg: '#ffffff' },
      { bg: '#db2777', fg: '#ffffff' }, { bg: '#0891b2', fg: '#ffffff' },
      { bg: '#ea580c', fg: '#ffffff' }, { bg: '#0d9488', fg: '#ffffff' },
      { bg: '#4f46e5', fg: '#ffffff' }
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  async getOrCreateUser(rawUsername, pin = '') {
    const cleanName = (rawUsername || '').trim();
    if (!cleanName || cleanName.length < 2) {
      throw new Error('Username must be at least 2 characters.');
    }
    if (cleanName.length > 24) {
      throw new Error('Username must be 24 characters or less.');
    }

    const key = cleanName.toLowerCase();
    let existing = await this.usersCollection.findOne({ username: key });
    const now = Date.now();

    if (existing) {
      if (existing.pinHash) {
        if (!pin) {
          return { error: 'PIN_REQUIRED', username: existing.displayName || cleanName };
        }
        const verify = await bcrypt.compare(pin, existing.pinHash);
        if (!verify) {
          return { error: 'INVALID_PIN', username: existing.displayName || cleanName };
        }
      } else if (pin) {
        const pinHash = await bcrypt.hash(pin, 10);
        await this.usersCollection.updateOne({ _id: existing._id }, { $set: { pinHash, lastSeen: now } });
        existing.pinHash = pinHash;
        existing.lastSeen = now;

        existing.username = existing.displayName || existing.username;
        return { success: true, user: existing, isNew: false };
      }

      await this.usersCollection.updateOne({ _id: existing._id }, { $set: { lastSeen: now } });
      existing.lastSeen = now;
      existing.username = existing.displayName || existing.username;
      return { success: true, user: existing, isNew: false };
    }

    let pinHash = null;
    if (pin) {
      pinHash = await bcrypt.hash(pin, 10);
    }

    const newUser = {
      id: `usr_${crypto.randomUUID().slice(0, 8)}`,
      username: key,
      displayName: cleanName,
      pinHash,
      joinedAt: now,
      lastSeen: now,
      avatarColor: this.generateAvatarColor(cleanName)
    };

    await this.usersCollection.insertOne(newUser);

    newUser.username = newUser.displayName;
    return { success: true, user: newUser, isNew: true };
  }

  async updateUserLastSeen(username) {
    const key = (username || '').trim().toLowerCase();
    await this.usersCollection.updateOne({ username: key }, { $set: { lastSeen: Date.now() } });
  }

  async getUser(username) {
    const key = (username || '').trim().toLowerCase();
    const user = await this.usersCollection.findOne({ username: key });
    if (user) {
      user.username = user.displayName || user.username;
    }
    return user;
  }

  async getAllUsers() {
    const users = await this.usersCollection.find({}).toArray();
    return users.map(u => ({
      username: u.displayName || u.username,
      joinedAt: u.joinedAt,
      lastSeen: u.lastSeen,
      avatarColor: u.avatarColor
    }));
  }

  async saveGroupMessage({ sender, text, type = 'chat', meta = {} }) {
    const msg = {
      id: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sender,
      text: String(text || '').trim(),
      type,
      meta,
      timestamp: Date.now()
    };
    await this.groupMessagesCollection.insertOne(msg);
    // don't send _id back to client
    delete msg._id;
    return msg;
  }

  async getGroupHistory(limit = 100, sinceTimestamp = 0) {
    const query = sinceTimestamp > 0 ? { timestamp: { $gte: sinceTimestamp } } : {};
    const docs = await this.groupMessagesCollection.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return docs.reverse().map(d => { delete d._id; return d; });
  }

  async savePersonalMessage({ sender, recipient, ciphertext, iv, salt, meta = {} }) {
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

    await this.personalMessagesCollection.insertOne(msg);
    delete msg._id;
    return msg;
  }

  async getPersonalHistory(user1, user2, limit = 100) {
    const u1 = (user1 || '');
    const u2 = (user2 || '');

    const docs = await this.personalMessagesCollection.find({
      $or: [
        { sender: { $regex: new RegExp(`^${u1}$`, 'i') }, recipient: { $regex: new RegExp(`^${u2}$`, 'i') } },
        { sender: { $regex: new RegExp(`^${u2}$`, 'i') }, recipient: { $regex: new RegExp(`^${u1}$`, 'i') } }
      ]
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    return docs.reverse().map(d => { delete d._id; return d; });
  }

  async getAllPersonalConversationsForUser(username) {
    const u = (username || '').toLowerCase();

    const docs = await this.personalMessagesCollection.find({
      $or: [
        { sender: { $regex: new RegExp(`^${u}$`, 'i') } },
        { recipient: { $regex: new RegExp(`^${u}$`, 'i') } }
      ]
    }).sort({ timestamp: -1 }).toArray();

    const map = {};

    for (const msg of docs) {
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

  async markPersonalMessagesAsRead(recipient, sender) {
    await this.personalMessagesCollection.updateMany(
      {
        recipient: { $regex: new RegExp(`^${recipient}$`, 'i') },
        sender: { $regex: new RegExp(`^${sender}$`, 'i') },
        read: false
      },
      { $set: { read: true } }
    );
  }
}

export const db = new ChatDatabase();
