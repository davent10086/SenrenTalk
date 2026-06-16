﻿﻿﻿﻿﻿﻿﻿﻿﻿import { motion } from "framer-motion";
import { MessageSquarePlus, Users } from "lucide-react";
import { useBootstrapContext } from "../context/BootstrapContext";
import { useViewContext } from "../context/ViewContext";
import { getAvatarPath } from "../utils/avatar";

export function CharacterListPage() {
  const { characters, bootstrapError, settingsError } = useBootstrapContext();
  const { startSingleChat, setCurrentView } = useViewContext();

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 10 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <motion.h2 initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>角色列表</motion.h2>
          <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}>
            选择一个角色开始单聊，或进入群聊创建页面。
          </motion.p>
        </div>
        <motion.button
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="primary-button"
          onClick={() => setCurrentView("group-create")}
        >
          <Users size={18} />创建群聊
        </motion.button>
      </div>

      <motion.div className="character-list" variants={containerVariants} initial="hidden" animate="visible">
        {characters.length === 0 ? (
          <div className="empty-state">
            <h3>当前没有可显示的角色</h3>
            <p className="muted">{bootstrapError ?? "角色数据尚未加载成功。你可以先去「系统设置」查看数据目录是否正确。"}</p>
            {settingsError ? <p className="muted">附加信息：{settingsError}</p> : null}
            <button className="secondary-button" onClick={() => setCurrentView("group-create")}>
              <Users size={18} />先看看群聊页
            </button>
          </div>
        ) : null}

        {characters.filter(c => c.isPlayable).map((character) => (
          <motion.article className="character-row" key={character.id} variants={itemVariants}>
            <img src={getAvatarPath(character.name)} alt={character.displayName} className="character-avatar" />
            <div className="character-info">
              <div className="character-name-group">
                <h3>{character.displayName}</h3>
                <span className={character.isPlayable ? "badge playable" : "badge"}>
                  {character.isPlayable ? "可扮演" : "剧情角色"}
                </span>
              </div>
              <p className="character-desc">{character.summary}</p>
              <div className="character-meta">
                <span>口吻：{character.promptProfile.tone}</span>
                <span>自称：{character.promptProfile.selfAddress}</span>
              </div>
            </div>
            <button className="secondary-button" onClick={() => void startSingleChat(character.id)} title="开始单聊">
              <MessageSquarePlus size={18} />开始单聊
            </button>
          </motion.article>
        ))}
      </motion.div>
    </section>
  );
}

