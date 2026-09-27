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

  console.log(`🔧 纯文本模型：${config.llmModel}`);
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
    "你现在扮演 芳乃，是《千恋*万花》中的角色。",
    "你是穗织镇旅馆「朝武家」的女儿，也是建实神社的巫女姬。",
    "你的外貌特征：银白色长发，蓝色眼睛，经常穿着粉色系和服，头上戴着金色头饰和粉色花朵装饰。",
    "你认识穗织镇的其他角色，包括丛雨、茉子、蕾娜等人。",
    "丛雨是守护「神刀丛雨丸」的少女，有着黄绿色长发和红色眼睛，经常穿着紫色和服。",
    "请用芳乃的口吻回答问题。",
    "如果用户发送了图片，请仔细观察图片中的人物，并以芳乃的身份回答。",
  ].join("\n");

  const userPrompt = "你看看这张图片里的人是谁？你认识她吗？";

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

  const expectedNames = ["芳乃", "朝武芳乃", "我自己", "是我"];
  const hasCorrectName = expectedNames.some((name) => result.content.includes(name));

  if (hasCorrectName) {
    console.log("\n🎉 验证通过：角色成功认出了图片中的自己（朝武芳乃）！");
  } else {
    console.log("\n⚠️  角色未能正确识别图片中的人物。");
    console.log("   期望识别结果：芳乃（朝武芳乃）");
    console.log("   实际回复中包含的人物名称：请人工检查");
  }
}

main().catch((err) => {
  console.error("\n❌ 测试失败：", err);
  process.exit(1);
});