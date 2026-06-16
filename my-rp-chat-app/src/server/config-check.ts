/**
 * 启动时校验关键环境变量配置，输出警告。
 * 不阻塞启动，但帮助开发者尽早发现配置错误。
 */

/**
 * 配置校验产生的单条警告信息。
 */
export interface ConfigValidationWarning {
  key: string;
  message: string;
  severity: "warning" | "error";
}

/**
 * 校验应用运行所需的关键环境变量。
 *
 * 检查项包括：
 * - DeepSeek API Key 是否配置
 * - Elasticsearch TLS 证书校验是否关闭（生产环境安全风险）
 * - Elasticsearch 密码强度
 * - LangSmith 追踪是否启用但未配置 API Key
 *
 * 该校验不会阻塞启动，仅输出警告。
 *
 * @returns 配置警告信息数组，校验通过时为空数组
 */
export function validateAppConfig(): ConfigValidationWarning[] {
  const warnings: ConfigValidationWarning[] = [];

  if (!process.env.DEEPSEEK_API_KEY) {
    warnings.push({
      key: "DEEPSEEK_API_KEY",
      message: "未配置 DeepSeek API Key，LLM 对话功能将不可用",
      severity: "error",
    });
  }

  if (process.env.ES_TLS_REJECT_UNAUTHORIZED?.toLowerCase() === "false") {
    warnings.push({
      key: "ES_TLS_REJECT_UNAUTHORIZED",
      message: "Elasticsearch TLS 证书校验已关闭，通信可能被中间人攻击——生产环境应设为 true",
      severity: "warning",
    });
  }

  if (process.env.ES_PASSWORD && process.env.ES_PASSWORD.length < 8) {
    warnings.push({
      key: "ES_PASSWORD",
      message: "Elasticsearch 密码强度不足，建议使用 8 位以上的复杂密码",
      severity: "warning",
    });
  }

  if (
    process.env.LANGSMITH_TRACING?.toLowerCase() === "true" &&
    !process.env.LANGSMITH_API_KEY
  ) {
    warnings.push({
      key: "LANGSMITH_API_KEY",
      message: "LangSmith 追踪已启用但未配置 API Key",
      severity: "warning",
    });
  }

  return warnings;
}

/**
 * 校验环境变量并将结果输出到控制台。
 * 内部调用 {@link validateAppConfig}，将警告按严重级别格式化输出。
 */
export function printConfigWarnings(): void {
  const warnings = validateAppConfig();

  if (warnings.length === 0) {
    console.log("[Config] 环境变量检查通过");
    return;
  }

  for (const warning of warnings) {
    const prefix = warning.severity === "error" ? "[Config ERROR]" : "[Config WARN]";
    console.warn(`${prefix} ${warning.key}: ${warning.message}`);
  }
}
