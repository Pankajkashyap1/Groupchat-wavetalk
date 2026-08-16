"use client";
import { useState } from "react";

export default function Composer({ onSend, onTyping, disabled }) {
  const [text, setText] = useState("");

  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="flex gap-2 px-5 py-3 border-t border-slate-200">
      <input
        value={text}
        disabled={disabled}
        maxLength={500}
        placeholder={disabled ? "Disconnected" : "Message the room"}
        onChange={(e) => { setText(e.target.value); onTyping(); }}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className="flex-1 px-4 py-2 rounded-lg border border-slate-300 outline-none focus:border-slate-900 text-sm text-slate-900"
      />
      <button
        onClick={submit}
        disabled={disabled || !text.trim()}
        className="px-5 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-40"
      >
        Send
      </button>
    </div>
  );
}