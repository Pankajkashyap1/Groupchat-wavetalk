import {
  encode, decode, validateName,
  JOIN, CHAT, TYPING,
  JOIN_OK, JOIN_ERROR, MESSAGE, SYSTEM, ROSTER, TYPING_UPDATE,
  MAX_MESSAGE,
} from "./protocol.js";

const clients = new Map();
let nextId = 1;

function roster() {
  return [...clients.values()].filter((c) => c.username).map((c) => c.username);
}

function broadcast(payload, exclude = null) {
  for (const [sock] of clients) {
    if (sock !== exclude && sock.readyState === 1) sock.send(payload);
  }
}

function sendRoster() {
  broadcast(encode(ROSTER, { users: roster() }));
}

function systemNotice(text) {
  broadcast(encode(SYSTEM, { id: nextId++, text, at: Date.now() }));
}

function handleJoin(sock, client, msg) {
  if (client.username) return;

  const problem = validateName(msg.username);
  if (problem) {
    sock.send(encode(JOIN_ERROR, { reason: problem }));
    return;
  }

  const name = msg.username.trim();
  const taken = roster().some((u) => u.toLowerCase() === name.toLowerCase());
  if (taken) {
    sock.send(encode(JOIN_ERROR, { reason: "That name is already in the room" }));
    return;
  }

  client.username = name;
  sock.send(encode(JOIN_OK, { username: name, users: roster() }));
  systemNotice(`${name} joined the room`);
  sendRoster();
  console.log(`[room] ${name} joined (${clients.size} connected)`);
}

function handleChat(sock, client, msg) {
  if (!client.username) return;
  if (typeof msg.text !== "string") return;

  const text = msg.text.trim().slice(0, MAX_MESSAGE);
  if (!text) return;

  broadcast(encode(MESSAGE, {
    id: nextId++,
    username: client.username,
    text,
    at: Date.now(),
  }));
}

function handleTyping(sock, client, msg) {
  if (!client.username) return;
  broadcast(
    encode(TYPING_UPDATE, { username: client.username, active: !!msg.active }),
    sock
  );
}

function handleClose(sock) {
  const client = clients.get(sock);
  clients.delete(sock);
  if (client?.username) {
    systemNotice(`${client.username} left the room`);
    sendRoster();
    console.log(`[room] ${client.username} left (${clients.size} connected)`);
  }
}

export function attachRoom(wss) {
  wss.on("connection", (sock) => {
    const client = { username: null, alive: true };
    clients.set(sock, client);

    sock.on("pong", () => { client.alive = true; });

    sock.on("message", (raw) => {
      const msg = decode(raw.toString());
      if (!msg) return;

      if (msg.type === JOIN) handleJoin(sock, client, msg);
      else if (msg.type === CHAT) handleChat(sock, client, msg);
      else if (msg.type === TYPING) handleTyping(sock, client, msg);
    });

    sock.on("close", () => handleClose(sock));
    sock.on("error", () => handleClose(sock));
  });

  const heartbeat = setInterval(() => {
    for (const [sock, client] of clients) {
      if (!client.alive) {
        sock.terminate();
        handleClose(sock);
        continue;
      }
      client.alive = false;
      sock.ping();
    }
  }, 30000);

  wss.on("close", () => clearInterval(heartbeat));
}