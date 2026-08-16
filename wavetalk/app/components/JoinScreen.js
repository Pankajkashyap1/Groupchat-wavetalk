"use client";
import { useState } from "react";

export default function JoinScreen({ onJoin, error, busy }) {
  const [name, setName] = useState("");

  const submit = () => {
    if (name.trim().length >= 2) onJoin(name.trim());
  };

  return (
    <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8">
      <h1 className="text-2xl font-medium text-slate-900">WaveTalk</h1>
      <p className="text-sm text-slate-500 mt-1 mb-6">
        Real-time chat over WebSockets
      </p>

      <input
        autoFocus
        maxLength={16}
        value={name}
        placeholder="Pick a username"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        className="w-full px-4 py-2.5 rounded-lg border border-slate-300 outline-none focus:border-slate-900 text-slate-900"
      />

      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}

      <button
        onClick={submit}
        disabled={busy || name.trim().length < 2}
        className="w-full mt-4 py-2.5 rounded-lg bg-slate-900 text-white disabled:opacity-40"
      >
        {busy ? "Connecting…" : "Join the room"}
      </button>
    </div>
  );
}