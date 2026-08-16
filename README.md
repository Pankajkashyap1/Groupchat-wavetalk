# WaveTalk — Secure Real-Time & Encrypted Chat

[![Node.js](https://img.shields.io/badge/Node.js-v16%2B%20%7C%20v18%2B%20%7C%20v20%2B-green.svg)](https://nodejs.org)
[![WebSocket](https://img.shields.io/badge/WebSockets-Real--Time-blue.svg)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
[![E2EE](https://img.shields.io/badge/Encryption-AES--GCM--256-blueviolet.svg)](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)
[![License](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)

A modern, fast, real-time chat web application featuring **#iitbhilai Group Rooms**, **Client-Side End-to-End Encrypted 1-on-1 Direct Messaging**, **Persistent Database Storage**, and **User Join & Message Timestamps**.

---

## ✨ Features

- ⚡ **Real-Time Group Chat (`#iitbhilai`)**: Instant messaging with live typing indicators and connection presence.
- 🔒 **End-to-End Encrypted DMs**: 1-on-1 personal messages are encrypted on your device using native `window.crypto.subtle` (AES-GCM 256-bit with PBKDF2 100,000 rounds). The server only stores encrypted ciphertext.
- 💾 **Persistent Database**: Chat histories and user profiles are stored persistently. Returning users get their full chat history restored upon logging back in.
- ⏱️ **Smart History & Join Timestamps**:
  - **New Users**: Group history starts clean — new users only see messages sent after they join.
  - **Old Users**: Returning users seamlessly load their past conversations.
  - Every message features clock timestamps and day dividers.
- 🛡️ **Safety Code Verification**: Verify encryption fingerprints with 1-on-1 chat partners.
- 📱 **Fluid Responsive UI**: Slate dark theme design with mobile drawer navigation, quick emoji tray, and search.

---

## 🚀 Quick Start

### 1. Clone the repository
```bash
git clone https://github.com/<your-username>/<your-repo-name>.git
cd wavetalk-main
```

### 2. Install dependencies
```bash
npm install
```

### 3. Start the server
```bash
npm start
```

### 4. Open in browser
Visit **[http://localhost:3000](http://localhost:3000)** (or your local IP address for multi-device testing).

---

## 🌐 Sharing via Live Public Link

To create an instant public HTTPS link that anyone on any network can open:

```bash
node server/server.js & ssh -R 80:localhost:3000 nokey@localhost.run
```

---

## 📁 Project Structure

```
wavetalk-main/
├── server/
│   ├── server.js          # HTTP static file server + WebSocket gateway
│   └── db.js              # Persistent database manager (Users, History, Encrypted DMs)
├── public/
│   ├── index.html         # HTML5 interface and modals
│   ├── style.css          # Modern dark slate CSS design system
│   ├── crypto.js          # Client-side AES-GCM 256-bit Web Crypto module
│   └── app.js             # Client controller (WebSocket, UI, DM routing, Audio)
├── tests/
│   ├── run.js             # Cross-version test runner
│   ├── chat.test.js       # Database unit tests
│   └── websocket_e2e.test.js # Multi-client E2E integration test
├── data/
│   └── chat_database.json # Persistent database file
└── package.json           # Scripts and dependencies
```

---

## 🧪 Running Tests

```bash
npm test
```

---

## 📄 License
MIT License. Free to use and modify.
