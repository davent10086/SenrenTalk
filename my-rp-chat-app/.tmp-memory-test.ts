import path from "node:path";
import { AppRuntime } from "./src/backend/app-runtime";

async function collectSse(streamUrl) {
  const response = await fetch(streamUrl);
  if (!response.ok || !response.body) {
    throw new Error(`SSE connect failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split(/\r?\n/).filter(Boolean);
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) {
        continue;
      }
      const eventName = eventLine.slice(7).trim();
      const payload = JSON.parse(dataLine.slice(6));
      events.push({ event: eventName, payload });
      if (eventName === "message_done" || eventName === "error") {
        return events;
      }
    }
  }

  return events;
}

async function sendAndWait(runtime, chatId, content) {
  const stream = await runtime.sendMessage({
    chatId,
    content,
    mode: "single",
    participants: ["芳乃"],
    mentionTarget: null,
  });
  const events = await collectSse(stream.streamUrl);
  const messages = runtime.listMessages(chatId);
  return {
    stream,
    events,
    lastAssistant: [...messages].reverse().find((message) => message.role === "assistant") ?? null,
    allMessages: messages,
  };
}

async function main() {
  const appRoot = process.cwd();
  const runtime = new AppRuntime(appRoot, path.join(appRoot, ".tmp-runtime-memory"));
  await runtime.start();

  const chat = runtime.createChat("single", ["芳乃"], "芳乃 记忆测试");

  const roundOne = await sendAndWait(runtime, chat.id, "请记住，我最喜欢樱花，也喜欢甜豆沙包。以后别忘了。");
  const sqliteMemoriesAfterRoundOne = runtime.repository.listMemoryEvents(chat.id, 10);
  const esMemoriesAfterRoundOne = await runtime.elasticsearchService.searchMemories("喜欢 樱花 甜豆沙包", {
    sessionId: chat.id,
    character: "芳乃",
    topK: 5,
  });

  const roundTwo = await sendAndWait(runtime, chat.id, "你还记得我刚才喜欢什么吗？请直接告诉我。 ");
  const sqliteSummary = runtime.repository.getSummary(chat.id);
  const sqliteMemoriesAfterRoundTwo = runtime.repository.listMemoryEvents(chat.id, 10);
  const esMemoriesAfterRoundTwo = await runtime.elasticsearchService.searchMemories("刚才 喜欢 什么", {
    sessionId: chat.id,
    character: "芳乃",
    topK: 5,
  });

  console.log(JSON.stringify({
    chatId: chat.id,
    roundOne: {
      eventCount: roundOne.events.length,
      doneEvent: roundOne.events.at(-1),
      lastAssistant: roundOne.lastAssistant,
      sqliteMemoryCount: sqliteMemoriesAfterRoundOne.length,
      esMemoryHits: esMemoriesAfterRoundOne.map((item) => ({
        sourceId: item.sourceId,
        text: item.text,
        character: item.character,
      })),
    },
    roundTwo: {
      eventCount: roundTwo.events.length,
      doneEvent: roundTwo.events.at(-1),
      lastAssistant: roundTwo.lastAssistant,
      sqliteMemoryCount: sqliteMemoriesAfterRoundTwo.length,
      summary: sqliteSummary,
      esMemoryHits: esMemoriesAfterRoundTwo.map((item) => ({
        sourceId: item.sourceId,
        text: item.text,
        character: item.character,
      })),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
