"use client";
import { useState, useRef, useEffect, useCallback } from "react";

export default function useChatSocket() {
  const [status, setStatus] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [users, setUsers] = useState([]);
  const [typers, setTypers] = useState([]);
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  const sock = useRef(null);
  const typingTimer = useRef(null);

  const connect = useCallback((username) => {
    if (sock.current) sock.current.close();

    setStatus("connecting");
    setError(null);

    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    sock.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "join", username }));

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case "join_ok":
          setMe(msg.username);
          setUsers(msg.users);
          setStatus("joined");
          break;
        case "join_error":
          setError(msg.reason);
          setStatus("idle");
          ws.close();
          break;
        case "message":
        case "system":
          setMessages((prev) => [...prev, msg]);
          break;
        case "roster":
          setUsers(msg.users);
          break;
        case "typing_update":
          setTypers((prev) =>
            msg.active
              ? prev.includes(msg.username) ? prev : [...prev, msg.username]
              : prev.filter((u) => u !== msg.username)
          );
          break;
      }
    };

    ws.onclose = () => {
      sock.current = null;
      setStatus((s) => (s === "joined" ? "disconnected" : s));
    };

    ws.onerror = () => setError("Could not reach the server");
  }, []);

  useEffect(() => () => sock.current?.close(), []);

  const send = useCallback((text) => {
    const body = text.trim();
    if (!body || sock.current?.readyState !== WebSocket.OPEN) return;
    sock.current.send(JSON.stringify({ type: "chat", text: body }));
    sock.current.send(JSON.stringify({ type: "typing", active: false }));
  }, []);

  const signalTyping = useCallback(() => {
    if (sock.current?.readyState !== WebSocket.OPEN) return;
    sock.current.send(JSON.stringify({ type: "typing", active: true }));
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      sock.current?.send(JSON.stringify({ type: "typing", active: false }));
    }, 2000);
  }, []);

  return { status, messages, users, typers, me, error, connect, send, signalTyping };
}