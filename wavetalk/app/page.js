"use client";
import useChatSocket from "./hooks/useChatSocket";
import JoinScreen from "./components/JoinScreen";
import ChatRoom from "./components/ChatRoom";

export default function Page() {
  const chat = useChatSocket();

  return (
    <main className="h-screen bg-slate-100 flex items-center justify-center p-4">
      {chat.status === "joined" ? (
        <ChatRoom {...chat} />
      ) : (
        <JoinScreen
          onJoin={chat.connect}
          error={chat.error}
          busy={chat.status === "connecting"}
        />
      )}
    </main>
  );
}