// Comprehensive Unit & Integration Test Suite for WaveTalk (Isolated Test DB)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChatDatabase } from '../server/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB_FILE = path.join(__dirname, '..', 'data', 'temp_unit_test.json');

// Clean up any old test db
if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);

const testDb = new ChatDatabase(TEST_DB_FILE);

test('Database: User registration, PIN hashing and Join Timestamps', async (t) => {
  // Test 1: Register new user
  const user1 = testDb.getOrCreateUser('Test_Alice', '1234');
  assert.equal(user1.success, true);
  assert.equal(user1.user.username, 'Test_Alice');
  assert.ok(user1.user.joinedAt > 0, 'Should have valid joinedAt timestamp');
  assert.ok(user1.user.pinHash, 'Should have hashed PIN');

  // Test 2: Existing user login with valid PIN
  const loginValid = testDb.getOrCreateUser('test_alice', '1234');
  assert.equal(loginValid.success, true);
  assert.equal(loginValid.isNew, false);

  // Test 3: Existing user login with invalid PIN
  const loginInvalid = testDb.getOrCreateUser('test_alice', 'wrong_pin');
  assert.equal(loginInvalid.error, 'INVALID_PIN');

  // Test 4: Register second user
  const user2 = testDb.getOrCreateUser('Test_Bob');
  assert.equal(user2.success, true);
  assert.ok(user2.user.joinedAt > 0);
});

test('Database: Group Chat Messages persistence and timestamps (New vs Returning User)', async (t) => {
  const msg1 = testDb.saveGroupMessage({
    sender: 'Test_Alice',
    text: 'Old message before Bob joined'
  });

  assert.ok(msg1.id.startsWith('grp_'));
  assert.equal(msg1.sender, 'Test_Alice');
  assert.ok(msg1.timestamp > 0);

  // New user joining at a later timestamp
  const bobJoinedAt = Date.now() + 50;
  const msg2 = testDb.saveGroupMessage({
    sender: 'Test_Alice',
    text: 'New message after Bob joined'
  });
  msg2.timestamp = bobJoinedAt + 10;

  // Full history
  const fullHistory = testDb.getGroupHistory(10);
  assert.ok(fullHistory.length >= 2);

  // Bob's filtered history (only messages since bobJoinedAt)
  const bobsHistory = testDb.getGroupHistory(10, bobJoinedAt);
  assert.equal(bobsHistory.length, 1);
  assert.equal(bobsHistory[0].text, 'New message after Bob joined');
});

test('Database: Encrypted Personal 1-on-1 Messages persistence & filtering', async (t) => {
  const pm1 = testDb.savePersonalMessage({
    sender: 'Test_Alice',
    recipient: 'Test_Bob',
    ciphertext: 'U2FsdGVkX1+vupppZksvRf5pq5g5XjFRIipRkw==',
    iv: 'dGVzdGl2MTIzNDU2'
  });

  assert.ok(pm1.id.startsWith('pm_'));
  assert.equal(pm1.sender, 'Test_Alice');
  assert.equal(pm1.recipient, 'Test_Bob');
  assert.equal(pm1.ciphertext, 'U2FsdGVkX1+vupppZksvRf5pq5g5XjFRIipRkw==');

  // Retrieve personal history between Alice and Bob
  const historyAliceBob = testDb.getPersonalHistory('Test_Alice', 'Test_Bob');
  assert.ok(historyAliceBob.length >= 1);
  assert.equal(historyAliceBob[historyAliceBob.length - 1].id, pm1.id);

  // Check from Bob's perspective
  const historyBobAlice = testDb.getPersonalHistory('Test_Bob', 'Test_Alice');
  assert.equal(historyBobAlice[historyBobAlice.length - 1].id, pm1.id);

  // Check conversations list
  const convos = testDb.getAllPersonalConversationsForUser('Test_Bob');
  assert.ok(convos.some(c => c.partner === 'Test_Alice'));
});

test('Database: User Roster with Join Times and Status', async (t) => {
  const allUsers = testDb.getAllUsers();
  assert.ok(allUsers.length >= 2);
  
  const alice = allUsers.find(u => u.username === 'Test_Alice');
  assert.ok(alice);
  assert.ok(alice.joinedAt > 0);
  assert.ok(alice.avatarColor);

  // Cleanup temp db
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
});
