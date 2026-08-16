// Cross-version Test Runner for Node 16, 18, 20+
import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { ChatDatabase } from '../server/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB_FILE = path.join(__dirname, '..', 'data', 'temp_unit_test.json');

if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);

async function run() {
  console.log('🧪 Starting WaveTalk Tests...');
  const testDb = new ChatDatabase(TEST_DB_FILE);

  // 1. User registration & PIN
  console.log('  Testing user registration and PIN...');
  const u1 = testDb.getOrCreateUser('User_Alpha', '1234');
  assert.equal(u1.success, true);
  assert.ok(u1.user.joinedAt > 0);

  const loginBad = testDb.getOrCreateUser('User_Alpha', 'wrong');
  assert.equal(loginBad.error, 'INVALID_PIN');

  const loginGood = testDb.getOrCreateUser('User_Alpha', '1234');
  assert.equal(loginGood.isNew, false);

  // 2. New vs Returning User Group History Visibility
  console.log('  Testing New vs Old User Chat History Visibility...');
  const oldMsg = testDb.saveGroupMessage({
    sender: 'User_Alpha',
    text: 'Early message before Beta registered'
  });

  const betaJoinedAt = Date.now() + 100;
  const u2 = testDb.getOrCreateUser('User_Beta');
  u2.user.joinedAt = betaJoinedAt;

  const newMsg = testDb.saveGroupMessage({
    sender: 'User_Alpha',
    text: 'Recent message after Beta registered'
  });
  newMsg.timestamp = betaJoinedAt + 10;

  // New user Beta only gets history from betaJoinedAt onwards
  const betaHistory = testDb.getGroupHistory(50, u2.user.joinedAt);
  assert.equal(betaHistory.length, 1);
  assert.equal(betaHistory[0].text, 'Recent message after Beta registered');

  // Returning user Alpha gets their full history
  const alphaHistory = testDb.getGroupHistory(50, u1.user.joinedAt);
  assert.equal(alphaHistory.length, 2);

  // 3. Encrypted personal message
  console.log('  Testing Encrypted Personal Messages...');
  const pm = testDb.savePersonalMessage({
    sender: 'User_Alpha',
    recipient: 'User_Beta',
    ciphertext: 'EncryptedSecretText',
    iv: 'random_iv_12'
  });
  assert.ok(pm.id.startsWith('pm_'));

  const conv = testDb.getPersonalHistory('User_Alpha', 'User_Beta');
  assert.equal(conv.length, 1);
  assert.equal(conv[0].ciphertext, 'EncryptedSecretText');

  // Clean up
  if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);

  console.log('✅ All Tests Passed Successfully!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
