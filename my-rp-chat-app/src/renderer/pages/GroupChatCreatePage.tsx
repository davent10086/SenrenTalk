import { useState } from "react";
import { motion } from "framer-motion";
import { MessageSquarePlus } from "lucide-react";
import { useBootstrapContext } from "../context/BootstrapContext";
import { useViewContext } from "../context/ViewContext";
import { getAvatarPath } from "../utils/avatar";

export function GroupChatCreatePage() {
  const { characters } = useBootstrapContext();
  const { createGroupChat } = useViewContext();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
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

  const handleCreate = () => void createGroupChat([...selected]);

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <motion.h2 initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>创建群聊</motion.h2>
          <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}>
            选择 2 到 5 个角色开始群聊
          </motion.p>
        </div>
        <motion.button
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="primary-button"
          disabled={selected.size < 2 || selected.size > 5}
          onClick={handleCreate}
        >
          <MessageSquarePlus size={18} />创建群聊（{selected.size} 人）
        </motion.button>
      </div>

      <motion.div className="character-list" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {characters.filter(c => c.isPlayable).map((c) => (
          <motion.article
            key={c.id}
            className={`character-row${selected.has(c.id) ? " selected" : ""}`}
            onClick={() => toggle(c.id)}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ cursor: "pointer" }}
          >
            <img src={getAvatarPath(c.name)} alt={c.displayName} className="character-avatar" />
            <div className="character-info">
              <div className="character-name-group">
                <h3>{c.displayName}</h3>
                <span className={c.isPlayable ? "badge playable" : "badge"}>
                  {c.isPlayable ? "可扮演" : "剧情角色"}
                </span>
              </div>
              <p className="character-desc">{c.summary}</p>
            </div>
          </motion.article>
        ))}
      </motion.div>
    </section>
  );
}
