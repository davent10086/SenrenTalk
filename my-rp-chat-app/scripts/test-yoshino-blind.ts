import fs from "node:fs";
import path from "node:path";
import { LlmService, type ImageInput } from "../src/backend/services/llm/llm-service";
import { createAppConfig } from "../src/backend/config";

function readImageFromFile(filePath: string): ImageInput {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType =
    ext === ".png" ? "image/png"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : "image/jpeg";
  return { mimeType, base64: buffer.toString("base64") };
}

async function main(): Promise<void> {
  const customPath = process.argv[2];
  const config = createAppConfig(process.cwd(), process.cwd());

  if (!config.llmApiKey) {
    console.error("❌ 未配置 LLM_API_KEY，请在 .env 中设置后重试。");
    process.exit(1);
  }

  console.log(`🔧 视觉模型：${config.llmVisionModel}`);
  console.log(`🔧 API 地址：${config.llmBaseUrl}`);

  if (!customPath) {
    console.error("❌ 请提供图片路径作为参数");
    process.exit(1);
  }

  if (!fs.existsSync(customPath)) {
    console.error(`❌ 指定的图片路径不存在：${customPath}`);
    process.exit(1);
  }

  console.log(`🖼️  使用自定义图片：${customPath}`);
  const image = readImageFromFile(customPath);

  const llm = new LlmService(config);

  const systemPrompt = [
    "你是一个动漫角色识别专家。",
    "请仔细观察图片中的人物，识别她是谁。",
    "如果认识，请说出她的名字和出处。",
    "如果不认识，请描述她的特征。",
  ].join("\n");

  const userPrompt = "请识别这张图片中的动漫角色是谁？出自哪部作品？";

  console.log("\n📨 系统提示词：");
  console.log(systemPrompt);
  console.log("\n📨 用户消息：");
  console.log(userPrompt);
  console.log("\n⏳ 正在调用 LLM 多模态接口，请稍候...\n");

  const tokens: string[] = [];
  const result = await llm.streamStructuredCompletion({
    systemPrompt,
    userPrompt,
    images: [image],
    onToken: (token) => {
      process.stdout.write(token);
      tokens.push(token);
    },
  });

  console.log("\n\n✅ ===== 测试结果 =====");
  console.log(`中文回复（content）：${result.content}`);
  console.log(`日语朗读（speechTextJa）：${result.speechTextJa}`);
  console.log(`原始输出（raw）：${result.raw}`);

  const expectedNames = ["朝武芳乃", "芳乃", "千恋", "Senren"];
  const hasCorrectName = expectedNames.some((name) => result.content.includes(name));

  if (hasCorrectName) {
    console.log("\n🎉 验证通过：模型成功识别出了角色！");
  } else {
    console.log("\n⚠️  模型未能仅凭自身知识识别出角色。");
    console.log("   期望识别结果：朝武芳乃，出自《千恋*万花》");
    console.log("   说明：模型需要提示词中的角色信息才能准确识别");
  }
}

main().catch((err) => {
  console.error("\n❌ 测试失败：", err);
  process.exit(1);
});