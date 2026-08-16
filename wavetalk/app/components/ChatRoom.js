"use client";
import UserList from "./UserList";
import MessageList from "./MessageList";
import Composer from "./Composer";

export default function ChatRoom({ messages, users, typers, me, status, send, signalTyping }) {
  const live = status === "joined";

  return (
    <div className="w-full max-w-4xl h-[85vh] bg-white rounded-2xl shadow-sm flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
        <div>
          <h1 className="font-medium text-slate-900">WaveTalk</h1>
          <p className="text-xs text-slate-500">{users.length} online</p>
        </div>
        <span
          className={`text-xs px-3 py-1 rounded-full ${
            live ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
          }`}
        >
          {live ? "connected" : "disconnected"}
        </span>
      </header>

      <div className="flex flex-1 min-h-0">
        <UserList users={users} me={me} />
        <div className="flex-1 flex flex-col min-w-0">
          <MessageList messages={messages} me={me} typers={typers} />
          <Composer onSend={send} onTyping={signalTyping} disabled={!live} />
        </div>
      </div>
    </div>
  );
}