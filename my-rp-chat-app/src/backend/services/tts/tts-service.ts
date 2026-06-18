import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../config";
import type { MessageAudio } from "../../../common/types";
import { RawData, WebSocket } from "ws";

interface SynthesizeInput {
  chatId: string;
  messageId: string;
  roleId?: string | null;
  text: string;
}

/**
 * TTS（文本转语音）服务，支持 OpenAI 兼容接口和 Qwen CosyVoice 两种后端。
 */
export class TtsService {
  /**
   * @param config 应用程序配置对象
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * 检查 TTS 服务是否已启用。
   * @returns 如果已配置受支持的 TTS 提供方则返回 true
   */
  isEnabled(): boolean {
    return this.config.ttsProvider === "openai-compatible" || this.config.ttsProvider === "qwen-cosyvoice";
  }

  /**
   * 根据角色 ID 解析对应的语音 ID，若未配置则返回默认语音。
   * @param roleId 角色 ID
   * @returns 语音 ID
   */
  resolveVoiceId(roleId?: string | null): string {
    if (roleId && this.config.ttsCharacterVoiceMap[roleId]) {
      return this.config.ttsCharacterVoiceMap[roleId];
    }
    return this.config.ttsDefaultVoice ?? "alloy";
  }

  /**
   * 合成语音音频文件。
   * @param input 合成参数，包含聊天 ID、消息 ID、角色 ID 和文本内容
   * @returns 合成后的音频信息
   * @throws 如果 TTS 未启用、API 密钥缺失、URL/模型未配置或文本为空
   */
  async synthesize(input: SynthesizeInput): Promise<MessageAudio> {
    if (!this.isEnabled()) {
      throw new Error("TTS_PROVIDER 未配置为受支持的 TTS 提供方。");
    }
    if (!this.config.ttsApiKey) {
      throw new Error("缺少 TTS_API_KEY。");
    }
    if (!this.config.ttsBaseUrl || !this.config.ttsModel) {
      throw new Error("缺少 TTS_BASE_URL 或 TTS_MODEL。");
    }

    const cleanText = this.stripStageDirections(input.text);
    if (!cleanText) {
      throw new Error("TTS 文本为空，无法合成语音。");
    }

    const voiceId = this.resolveVoiceId(input.roleId);
    const audio = this.config.ttsProvider === "qwen-cosyvoice"
      ? await this.synthesizeWithQwenCosyVoice({ ...input, text: cleanText }, voiceId)
      : await this.synthesizeWithOpenAiCompatible({ ...input, text: cleanText }, voiceId);

    return {
      status: "ready",
      voiceId,
      relativePath: audio.relativePath,
      mimeType: audio.mimeType,
    };
  }

  /**
   * 移除括号内的动作描写、舞台指示、心理活动等非台词内容，
   * 并清理多余空白，确保 TTS 只朗读实际说出口的文本。
   */
  private stripStageDirections(text: string): string {
    return text
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/【[^】]*】/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private async synthesizeWithOpenAiCompatible(
    input: SynthesizeInput,
    voiceId: string,
  ): Promise<{ relativePath: string; mimeType: string }> {
    const response = await fetch(`${this.config.ttsBaseUrl!.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.ttsApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.ttsModel,
        voice: voiceId,
        input: input.text,
        format: "mp3",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TTS 请求失败: ${response.status} ${errorText}`.trim());
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return this.writeAudioFile(input, buffer, "mp3", "audio/mpeg");
  }

  private async synthesizeWithQwenCosyVoice(
    input: SynthesizeInput,
    voiceId: string,
  ): Promise<{ relativePath: string; mimeType: string }> {
    const audioChunks = await new Promise<Buffer[]>((resolve, reject) => {
      const socket = new WebSocket(this.config.ttsBaseUrl!, {
        headers: {
          Authorization: `Bearer ${this.config.ttsApiKey}`,
        },
      });
      const taskId = randomUUID();
      const chunks: Buffer[] = [];
      let started = false;
      let settled = false;

      const fail = (reason: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.close();
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };

      const succeed = () => {
        if (settled) {
          return;
        }
        settled = true;
        socket.close();
        resolve(chunks);
      };

      socket.on("open", () => {
        socket.send(JSON.stringify({
          header: {
            action: "run-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: {
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            model: this.config.ttsModel,
            parameters: {
              text_type: "PlainText",
              voice: voiceId,
              format: "wav",
              sample_rate: 24000,
              rate: 1,
              pitch: 1,
              volume: 50,
            },
            input: {},
          },
        }));
      });

      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          if (Buffer.isBuffer(data)) {
            chunks.push(data);
          } else if (Array.isArray(data)) {
            chunks.push(Buffer.concat(data));
          } else {
            chunks.push(Buffer.from(data));
          }
          return;
        }

        let message: {
          header?: { event?: string };
          payload?: { error_message?: string; output?: { sentence?: { text?: string } } };
        };
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }

        const event = message.header?.event;
        if (event === "task-failed") {
          const detail = message.payload?.error_message
            ?? JSON.stringify(message.payload ?? {})
            ?? "未知错误";
          fail(new Error(`CosyVoice 任务失败: ${detail}`));
          return;
        }
        if (event === "task-started" && !started) {
          started = true;
          socket.send(JSON.stringify({
            header: {
              action: "continue-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: {
              input: {
                text: input.text,
              },
            },
          }));
          socket.send(JSON.stringify({
            header: {
              action: "finish-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: {
              input: {},
            },
          }));
          return;
        }
        if (event === "task-finished") {
          if (chunks.length === 0) {
            fail(new Error("CosyVoice 未返回音频数据"));
            return;
          }
          succeed();
        }
      });

      socket.on("error", (error: Error) => {
        fail(error);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        if (!settled && code !== 1000) {
          fail(new Error(`CosyVoice 连接关闭: ${code} ${reason.toString()}`.trim()));
        }
      });
    });

    return this.writeAudioFile(input, Buffer.concat(audioChunks), "wav", "audio/wav");
  }

  private async writeAudioFile(
    input: SynthesizeInput,
    buffer: Buffer,
    extension: string,
    mimeType: string,
  ): Promise<{ relativePath: string; mimeType: string }> {
    const audioDir = path.join(this.config.mediaDir, "audio", input.chatId);
    await fs.mkdir(audioDir, { recursive: true });
    const fileName = `${input.messageId}.${extension}`;
    const relativePath = path.posix.join("audio", input.chatId, fileName);
    const absolutePath = path.join(audioDir, fileName);
    await fs.writeFile(absolutePath, buffer);
    return { relativePath, mimeType };
  }
}
