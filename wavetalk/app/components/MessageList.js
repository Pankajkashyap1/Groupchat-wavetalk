"use client";
import { useRef, useEffect } from "react";
import Message from "./Message";

export default function MessageList({ messages, me, typers }) {
  const box = useRef(null);
  const pinned = useRef(true);

  const onScroll = () => {
    const el = box.current;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  useEffect(() => {
    if (pinned.current && box.current) {
      box.current.scrollTop = box.current.scrollHeight;
    }
  }, [messages, typers]);

  return (
    <div ref={box} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-4">
      {messages.length === 0 && (
        <p className="text-center text-sm text-slate-400 mt-8">
          No messages yet — say hi.
        </p>
      )}

      {messages.map((m, i) => (
        <Message
          key={m.id}
          msg={m}
          me={me}
          grouped={
            i > 0 &&
            messages[i - 1].type === "message" &&
            m.type === "message" &&
            messages[i - 1].username === m.username &&
            m.at - messages[i - 1].at < 60000
          }
        />
      ))}

      {typers.length > 0 && (
        <p className="text-xs text-slate-400 italic mt-1">
          {typers.join(", ")} {typers.length === 1 ? "is" : "are"} typing…
        </p>
      )}
    </div>
  );
}