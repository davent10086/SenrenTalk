import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatRecord } from "../../common/types";
import * as apiClient from "../api/client";

type View = "characters" | "single" | "group-create" | "group" | "settings";

interface ViewContextValue {
  currentView: View;
  setCurrentView: (view: View) => void;
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;
  activeChat: ChatRecord | null;
  mentionTarget: string | null;
  setMentionTarget: (target: string | null) => void;
  startSingleChat: (characterId: string) => Promise<void>;
  createGroupChat: (participants: string[]) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  chats: ChatRecord[];
  refreshChats: () => Promise<void>;
}

const ViewContext = createContext<ViewContextValue | null>(null);

export function ViewProvider({ children }: { children: ReactNode }) {
  const [currentView, setCurrentView] = useState<View>("characters");
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [mentionTarget, setMentionTarget] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRecord[]>([]);

  const refreshChats = useCallback(async () => {
    setChats(await apiClient.listChats());
  }, []);

  useEffect(() => { void refreshChats(); }, [refreshChats]);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? null,
    [activeChatId, chats],
  );

  const startSingleChat = useCallback(async (characterId: string) => {
    const existing = chats.find(
      (chat) => chat.mode === "single" && chat.participants[0] === characterId,
    ) ?? null;
    const chat = existing ?? await apiClient.createChat({
      mode: "single",
      participants: [characterId],
      title: `${characterId} 单聊`,
    });
    await refreshChats();
    setActiveChatId(chat.id);
    setCurrentView("single");
  }, [chats, refreshChats]);

  const createGroupChat = useCallback(async (participants: string[]) => {
    const chat = await apiClient.createChat({
      mode: "group",
      participants,
      title: `${participants.join(" / ")} 群聊`,
    });
    await refreshChats();
    setActiveChatId(chat.id);
    setCurrentView("group");
  }, [refreshChats]);

  const deleteChat = useCallback(async (chatId: string) => {
    await apiClient.deleteChat(chatId);
    if (activeChatId === chatId) {
      setActiveChatId(null);
      setCurrentView("characters");
    }
    await refreshChats();
  }, [activeChatId, refreshChats]);

  const value = useMemo<ViewContextValue>(() => ({
    currentView, setCurrentView,
    activeChatId, setActiveChatId,
    activeChat,
    mentionTarget, setMentionTarget,
    startSingleChat, createGroupChat, deleteChat,
    chats, refreshChats,
  }), [currentView, activeChatId, activeChat, mentionTarget, chats, startSingleChat, createGroupChat, deleteChat, refreshChats]);

  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export function useViewContext(): ViewContextValue {
  const ctx = useContext(ViewContext);
  if (!ctx) throw new Error("useViewContext must be used within a ViewProvider");
  return ctx;
}
