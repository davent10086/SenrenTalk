import type { AppConfig } from "../../config";

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

export class BgeM3EmbeddingService {
  constructor(private readonly config: AppConfig) {}

  async embed(text: string): Promise<number[]> {
    const normalizedText = text.replace(/\s+/g, " ").trim();
    if (!normalizedText) {
      return new Array<number>(this.config.embeddingDimensions).fill(0);
    }

    const response = await fetch(`${this.config.ollamaHost.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.ollamaModelName,
        input: [normalizedText],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding 请求失败: ${response.status} ${body}`);
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    const embedding = data.embeddings?.[0];
    if (!embedding) {
      throw new Error("Ollama embedding 返回为空。");
    }
    if (embedding.length !== this.config.embeddingDimensions) {
      throw new Error(
        `Ollama embedding 维度不匹配，期望 ${this.config.embeddingDimensions}，实际 ${embedding.length}。`,
      );
    }
    return embedding;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const normalizedTexts = texts.map((text) => text.replace(/\s+/g, " ").trim());
    const response = await fetch(`${this.config.ollamaHost.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.ollamaModelName,
        input: normalizedTexts,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding 批量请求失败: ${response.status} ${body}`);
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    const embeddings = data.embeddings ?? [];
    if (embeddings.length !== normalizedTexts.length) {
      throw new Error("Ollama embedding 批量返回数量与输入不一致。");
    }

    embeddings.forEach((embedding) => {
      if (embedding.length !== this.config.embeddingDimensions) {
        throw new Error(
          `Ollama embedding 维度不匹配，期望 ${this.config.embeddingDimensions}，实际 ${embedding.length}。`,
        );
      }
    });

    return embeddings;
  }
}
