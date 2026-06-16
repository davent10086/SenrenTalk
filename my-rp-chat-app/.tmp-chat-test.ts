import path from "node:path";
import { AppRuntime } from "./src/backend/app-runtime";

async function readSse(streamUrl) {
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

async function main() {
  const appRoot = process.cwd();
  const runtime = new AppRuntime(appRoot, path.join(appRoot, ".tmp-runtime"));
  await runtime.start();

  const chat = runtime.createChat("single", ["芳乃"], "芳乃 单聊测试");
  const stream = await runtime.sendMessage({
    chatId: chat.id,
    content: "芳乃，今天想和你去神社散步，你会怎么回应我？",
    mode: "single",
    participants: ["芳乃"],
    mentionTarget: null,
  });

  const events = await readSse(stream.streamUrl);
  const messages = runtime.listMessages(chat.id);
  console.log(JSON.stringify({
    stream,
    eventCount: events.length,
    lastEvent: events.at(-1),
    finalMessages: messages.slice(-2),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
