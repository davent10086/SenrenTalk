/**
 * 多模态 LLM 图片识别本地测试脚本
 *
 * 生成一张有明确特征的测试图片（64x64 四色方块：红/绿/蓝/黄），
 * 然后真实调用 qwen-plus 多模态接口，验证角色能否正确识别图片内容。
 *
 * 用法：
 *   npx tsx scripts/test-multimodal.ts
 *
 * 也可传入自定义图片路径测试自己的图片：
 *   npx tsx scripts/test-multimodal.ts "C:\path\to\your.png"
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { LlmService, type ImageInput } from "../src/backend/services/llm/llm-service";
import { createAppConfig } from "../src/backend/config";

/** PNG chunk 类型 + 数据 + CRC32 校验。 */
function buildChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** CRC32 实现（PNG 规范要求）。 */
function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { _table?: number[] })._table;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    (crc32 as unknown as { _table?: number[] })._table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 生成一张 64x64 的 PNG 图片，分为四个色块：
 *   左上=红  右上=绿
 *   左下=蓝  右下=黄
 * 颜色对比明显，便于验证 LLM 是否真的"看懂"了图片。
 */
function generateFourColorPng(): Buffer {
  const width = 64;
  const height = 64;
  // 每行前加 1 字节 filter(0)，每像素 3 字节 RGB
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const offset = y * rowSize + 1 + x * 3;
      const leftHalf = x < width / 2;
      const topHalf = y < height / 2;
      if (topHalf && leftHalf) {
        // 红色
        raw[offset] = 220;
        raw[offset + 1] = 30;
        raw[offset + 2] = 30;
      } else if (topHalf && !leftHalf) {
        // 绿色
        raw[offset] = 30;
        raw[offset + 1] = 200;
        raw[offset + 2] = 30;
      } else if (!topHalf && leftHalf) {
        // 蓝色
        raw[offset] = 30;
        raw[offset + 1] = 60;
        raw[offset + 2] = 220;
      } else {
        // 黄色
        raw[offset] = 240;
        raw[offset + 1] = 220;
        raw[offset + 2] = 30;
      }
    }
  }

  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    buildChunk("IHDR", ihdr),
    buildChunk("IDAT", idat),
    buildChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 从文件路径读取图片并转为 ImageInput。 */
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

  // 准备测试图片
  let image: ImageInput;
  if (customPath) {
    if (!fs.existsSync(customPath)) {
      console.error(`❌ 指定的图片路径不存在：${customPath}`);
      process.exit(1);
    }
    console.log(`🖼️  使用自定义图片：${customPath}`);
    image = readImageFromFile(customPath);
  } else {
    console.log("🖼️  生成测试图片：64x64 四色方块（红/绿/蓝/黄）");
    const pngBuffer = generateFourColorPng();
    // 同时保存到本地，方便人工查看
    const outPath = path.join(process.cwd(), "test-multimodal-output.png");
    fs.writeFileSync(outPath, pngBuffer);
    console.log(`   已保存测试图片到：${outPath}`);
    image = { mimeType: "image/png", base64: pngBuffer.toString("base64") };
  }

  const llm = new LlmService(config);

  // 模拟角色的系统提示词（简化版）
  const systemPrompt = [
    "你现在扮演 芳乃，一位温柔的少女角色。",
    "请用自然中文回复用户，保持角色口吻。",
    "如果用户发送了图片，请仔细观察图片内容并描述你看到的东西。",
  ].join("\n");

  const userPrompt = "你看看这张图片里有什么？请描述你看到的内容。";

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

  // 简单断言：如果 LLM 回复中包含颜色相关词汇，说明识别成功
  const colorKeywords = ["红", "绿", "蓝", "黄", "色", "方块", "四", "颜色"];
  const hasColorMention = colorKeywords.some((kw) => result.content.includes(kw));
  if (hasColorMention) {
    console.log("\n🎉 验证通过：LLM 成功识别了图片中的内容！");
  } else {
    console.log("\n⚠️  警告：LLM 回复中未检测到颜色相关词汇，请检查图片是否正确传递。");
  }
}

main().catch((err) => {
  console.error("\n❌ 测试失败：", err);
  process.exit(1);
});
