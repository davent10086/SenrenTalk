﻿import { motion } from "framer-motion";
import { Database, RefreshCw, Settings2 } from "lucide-react";
import { useBootstrapContext } from "../context/BootstrapContext";
import { useChatContext } from "../context/ChatContext";

export function SettingsPage() {
  const { settings } = useBootstrapContext();
  const { jobs, rebuildIndex } = useChatContext();

  const latestIndexJob = jobs.find((job) => job.type === "index_dialogues") ?? null;

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <motion.h2 initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>设置与调试</motion.h2>
          <motion.p initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}>
            查看当前后端配置，并以后台任务方式触发对话索引重建。
          </motion.p>
        </div>
        <motion.button initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="primary-button" onClick={rebuildIndex}>
          <RefreshCw size={18} />重建对话索引
        </motion.button>
      </div>

      {settings ? (
        <motion.div className="settings-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px" }}>
          <motion.article style={{ padding: "24px", borderRadius: "16px", background: "var(--theme-surface)", border: "1px solid var(--theme-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
              <Settings2 size={20} style={{ color: "var(--theme-primary)" }} />
              <h3 style={{ margin: 0 }}>运行配置</h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--theme-text-muted)", fontSize: "0.95rem" }}>
              <p style={{ margin: 0 }}><strong>应用名称：</strong>{settings.appName}</p>
              <p style={{ margin: 0 }}><strong>模型：</strong>{settings.llmModel}</p>
              <p style={{ margin: 0 }}><strong>ES 节点：</strong>{settings.esNode}</p>
              <p style={{ margin: 0, wordBreak: "break-all" }}><strong>数据目录：</strong>{settings.datasetDir}</p>
            </div>
          </motion.article>
          <motion.article style={{ padding: "24px", borderRadius: "16px", background: "var(--theme-surface)", border: "1px solid var(--theme-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
              <Database size={20} style={{ color: "var(--theme-primary)" }} />
              <h3 style={{ margin: 0 }}>索引信息</h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--theme-text-muted)", fontSize: "0.95rem" }}>
              <p style={{ margin: 0 }}><strong>对话索引：</strong>{settings.dialogueIndex}</p>
              <p style={{ margin: 0 }}><strong>记忆索引：</strong>{settings.memoryIndex}</p>
              <p style={{ margin: 0 }}>
                <strong>ES 状态：</strong>
                <span className={settings.esEnabled ? "badge playable" : "badge"} style={{ marginLeft: "8px" }}>
                  {settings.esEnabled ? "已启用" : "未启用"}
                </span>
              </p>
              <p style={{ margin: 0 }}>
                <strong>最近索引任务：</strong>
                <span className="badge" style={{ marginLeft: "8px" }}>{latestIndexJob ? latestIndexJob.status : "暂无"}</span>
              </p>
              {latestIndexJob?.result?.indexedCount ? (
                <p style={{ margin: 0 }}><strong>最近索引量：</strong>{String(latestIndexJob.result.indexedCount)}</p>
              ) : null}
              {latestIndexJob?.error ? (
                <p style={{ margin: 0, color: "var(--theme-danger, #c0392b)" }}><strong>任务错误：</strong>{latestIndexJob.error}</p>
              ) : null}
            </div>
          </motion.article>
        </motion.div>
      ) : (
        <p className="muted">正在加载设置...</p>
      )}
    </section>
  );
}
