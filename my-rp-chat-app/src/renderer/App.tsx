﻿﻿﻿﻿﻿﻿import { useMemo } from "react";
import { Settings, Users, User } from "lucide-react";
import type { ChatRecord } from "../common/types";
import { BootstrapProvider, useBootstrapContext } from "./context/BootstrapContext";
import { ViewProvider, useViewContext } from "./context/ViewContext";
import { ChatProvider } from "./context/ChatContext";
import { CharacterListPage } from "./pages/CharacterListPage";
import { GroupChatCreatePage } from "./pages/GroupChatCreatePage";
import { GroupChatPage } from "./pages/GroupChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SingleChatPage } from "./pages/SingleChatPage";

function getThemeClass(chat: ChatRecord | null): string {
  if (!chat || chat.mode !== "single") return "";
  const p = chat.participants[0] || "";
  if (p.includes("芳乃") || p.toLowerCase().includes("yoshino")) return "theme-yoshino";
  if (p.includes("茉子") || p.toLowerCase().includes("mako")) return "theme-mako";
  if (p.includes("丛雨") || p.toLowerCase().includes("murasame")) return "theme-murasame";
  if (p.includes("蕾娜") || p.toLowerCase().includes("lena")) return "theme-lena";
  return "";
}

function AppContent() {
  const { currentView, activeChat, activeChatId, chats, setCurrentView, setActiveChatId } = useViewContext();
  const themeClass = useMemo(() => getThemeClass(activeChat), [activeChat]);

  return (
    <div className={`app-shell ${themeClass}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>SenrenTalk</h1>
          <p className="muted">基于检索增强的角色扮演对话引擎</p>
        </div>
        <div className="sidebar-content">
          <nav className="sidebar-nav">
            <button className={currentView === "characters" ? "active" : ""} onClick={() => setCurrentView("characters")}>
              <User size={18} />角色列表
            </button>
            <button className={currentView === "group-create" ? "active" : ""} onClick={() => setCurrentView("group-create")}>
              <Users size={18} />创建群聊
            </button>
            <button className={currentView === "settings" ? "active" : ""} onClick={() => setCurrentView("settings")}>
              <Settings size={18} />系统设置
            </button>
          </nav>

          <div className="sidebar-section">
            <h3>历史会话</h3>
            <div className="chat-list">
              {chats.map((chat) => (
                <button
                  key={chat.id}
                  className={
                    chat.id === activeChatId && (currentView === "single" || currentView === "group")
                      ? "chat-list-item active" : "chat-list-item"
                  }
                  onClick={() => {
                    setActiveChatId(chat.id);
                    setCurrentView(chat.mode === "group" ? "group" : "single");
                  }}
                >
                  <strong>{chat.title}</strong>
                  <span className="muted">{chat.participants.join(" / ")}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>

      <main className="content">
        {currentView === "characters" && <CharacterListPage />}
        {currentView === "group-create" && <GroupChatCreatePage />}
        {currentView === "single" && <SingleChatPage />}
        {currentView === "group" && <GroupChatPage />}
        {currentView === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

function App() {
  return (
    <BootstrapProvider>
      <ViewProvider>
        <ChatProvider>
          <AppContent />
        </ChatProvider>
      </ViewProvider>
    </BootstrapProvider>
  );
}

export default App;
