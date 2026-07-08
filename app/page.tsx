"use client";

import ChatPanel from "@/components/ChatPanel";
import Viewport from "@/components/Viewport";
import CreditsFooter from "@/components/CreditsFooter";

export default function Home() {
  // The scene starts empty and is built entirely from the learner's first
  // message onward — either a realistic GLB base model or primitive parts.
  return (
    <main className="flex h-screen w-screen overflow-hidden">
      <div className="w-[35%] min-w-[300px] max-w-[480px]">
        <ChatPanel />
      </div>
      <div className="relative flex-1">
        <Viewport />
        <CreditsFooter />
      </div>
    </main>
  );
}
