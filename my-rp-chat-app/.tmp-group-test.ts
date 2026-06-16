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
      events.push({
        event: eventLine.slice(7).trim(),
        payload: JSON.parse(dataLine.slice(6)),
      });
    }
  }

  return events;
}

async function runScenario(runtime, title, payload) {
  const chat = runtime.createChat(payload.mode, payload.participants, title);
  const stream = await runtime.sendMessage({
    chatId: chat.id,
    content: payload.content,
    mode: payload.mode,
    participants: payload.participants,
    mentionTarget: payload.mentionTarget ?? null,
  });
  const events = await collectSse(stream.streamUrl);
  const messages = runtime.listMessages(chat.id);
  return {
    title,
    streamId: stream.streamId,
    messageDoneRoles: events.filter((event) => event.event === "message_done").map((event) => event.payload.roleId ?? null),
    errorEvents: events.filter((event) => event.event === "error"),
    finalMessages: messages.slice(-5).map((message) => ({ role: message.role, roleId: message.roleId ?? null, content: message.content })),
  };
}

async function main() {
  const appRoot = process.cwd();
  const runtime = new AppRuntime(appRoot, path.join(appRoot, ".tmp-runtime-group"));
  await runtime.start();

  const groupRound = await runScenario(runtime, "群聊轮流测试", {
    mode: "group",
    participants: ["芳乃", "丛雨"],
    content: "大家好，今天我们一起去神社散步怎么样？",
  });

  const mentionRound = await runScenario(runtime, "群聊@角色测试", {
    mode: "group",
    participants: ["芳乃", "丛雨"],
    content: "@丛雨 你先回答我，愿意一起去吗？",
    mentionTarget: "丛雨",
  });

  console.log(JSON.stringify({ groupRound, mentionRound }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
