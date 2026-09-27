import { useState } from "react";
import { motion } from "framer-motion";
import { MessageSquarePlus } from "lucide-react";
import { createGroupChatRoomConfigForMode, type GroupChatRoomMode } from "../../common/types";
import { useBootstrapContext } from "../context/BootstrapContext";
import { useViewContext } from "../context/ViewContext";
import { getAvatarPath } from "../utils/avatar";

export function GroupChatCreatePage() {
  const { characters } = useBootstrapContext();
  const { createGroupChat } = useViewContext();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<GroupChatRoomMode>("single_round");
  const [hostRoleId, setHostRoleId] = useState("");

  const toggle = (id: string) => {
    if (selected.has(id) && hostRoleId === id) setHostRoleId("");
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 5) {
        next.add(id);
      }
      return next;
    });
  };

  const handleCreate = () => {
    const participants = [...selected];
    const defaults = createGroupChatRoomConfigForMode(participants.length, mode);
    void createGroupChat(participants, {
      ...defaults,
      hostRoleId: mode === "host_mode" ? hostRoleId : null,
    });
  };

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <motion.h2 initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>创建群聊</motion.h2>
          <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}>
            先选角色，再决定群聊模式
          </motion.p>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as GroupChatRoomMode)}
            style={{ padding: "8px 10px", borderRadius: "8px" }}
          >
            <option value="single_round">一轮回应</option>
            <option value="free_chat">自由群聊</option>
            <option value="host_mode">主持模式</option>
          </select>
          {mode === "host_mode" ? (
            <select aria-label="选择主持角色" value={hostRoleId} onChange={(event) => setHostRoleId(event.target.value)}>
              <option value="">选择主持角色</option>
              {[...selected].map((roleId) => <option key={roleId} value={roleId}>{roleId}</option>)}
            </select>
          ) : null}
          <motion.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="primary-button"
            disabled={selected.size < 2 || selected.size > 5 || (mode === "host_mode" && !hostRoleId)}
            onClick={handleCreate}
          >
            <MessageSquarePlus size={18} />创建群聊（{selected.size} 人）
          </motion.button>
        </div>
      </div>

      <motion.div className="character-list" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {characters.filter((character) => character.isPlayable).map((character) => (
          <motion.article
            key={character.id}
            className={`character-row${selected.has(character.id) ? " selected" : ""}`}
            onClick={() => toggle(character.id)}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ cursor: "pointer" }}
          >
            <img src={getAvatarPath(character.name)} alt={character.displayName} className="character-avatar" />
            <div className="character-info">
              <div className="character-name-group">
                <h3>{character.displayName}</h3>
                <span className={character.isPlayable ? "badge playable" : "badge"}>
                  {character.isPlayable ? "可扮演" : "剧情角色"}
                </span>
              </div>
              <p className="character-desc">{character.summary}</p>
            </div>
          </motion.article>
        ))}
      </motion.div>
    </section>
  );
}
