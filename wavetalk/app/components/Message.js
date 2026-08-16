"use client";
import { colorFor, initials, clockTime } from "../lib/avatar";

export default function Message({ msg, me, grouped }) {
  if (msg.type === "system") {
    return (
      <p className="text-center text-xs text-slate-400 my-3">{msg.text}</p>
    );
  }

  const mine = msg.username === me;

  if (mine) {
    return (
      <div className="flex justify-end mb-1">
        <div className="max-w-[75%] px-3 py-2 rounded-xl bg-indigo-50 text-indigo-900 text-sm">
          {msg.text}
        </div>
      </div>
    );
  }

  const c = colorFor(msg.username);

  return (
    <div className={`flex gap-2 ${grouped ? "mb-1" : "mb-1 mt-3"}`}>
      <div className="w-7 shrink-0">
        {!grouped && (
          <span
            className="w-7 h-7 rounded-full text-[10px] flex items-center justify-center"
            style={{ background: c.bg, color: c.fg }}
          >
            {initials(msg.username)}
          </span>
        )}
      </div>
      <div className="min-w-0">
        {!grouped && (
          <p className="text-xs text-slate-500 mb-0.5">
            {msg.username} <span className="text-slate-400">{clockTime(msg.at)}</span>
          </p>
        )}
        <div className="inline-block px-3 py-2 rounded-xl bg-slate-100 text-slate-800 text-sm">
          {msg.text}
        </div>
      </div>
    </div>
  );
}