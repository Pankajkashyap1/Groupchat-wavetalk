"use client";
import { colorFor, initials } from "../lib/avatar";

export default function UserList({ users, me }) {
  return (
    <aside className="w-44 border-r border-slate-200 p-3 overflow-y-auto hidden sm:block">
      <p className="text-xs text-slate-400 mb-3">ONLINE</p>
      {users.map((u) => {
        const c = colorFor(u);
        return (
          <div key={u} className="flex items-center gap-2 mb-2.5">
            <span
              className="w-6 h-6 rounded-full text-[10px] flex items-center justify-center shrink-0"
              style={{ background: c.bg, color: c.fg }}
            >
              {initials(u)}
            </span>
            <span className="text-sm text-slate-700 truncate">
              {u}
              {u === me && <span className="text-slate-400 text-xs"> (you)</span>}
            </span>
          </div>
        );
      })}
    </aside>
  );
}