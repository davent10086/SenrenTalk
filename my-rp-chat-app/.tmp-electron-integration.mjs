import { app } from "electron";

process.env.VITE_DEV_SERVER_URL = "http://localhost:5173/";
process.env.NODE_ENV = "development";

let finished = false;

function safeExit(code = 0) {
  if (finished) {
    return;
  }
  finished = true;
  setTimeout(() => {
    app.exit(code);
  }, 200);
}

app.on("browser-window-created", (_event, win) => {
  win.webContents.once("did-finish-load", async () => {
    try {
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          const bootstrap = await window.rpChat.bootstrap();
          const settings = await window.rpChat.getSettings();
          const chat = await window.rpChat.createChat({
            mode: "single",
            participants: ["芳乃"],
            title: "Electron 前后端联调"
          });
          const stream = await window.rpChat.sendMessage({
            chatId: chat.id,
            content: "芳乃，请用一句话告诉我你记得这是 Electron 真实联调。",
            mode: "single",
            participants: ["芳乃"],
            mentionTarget: null
          });

          const streamSummary = await new Promise((resolve) => {
            const summary = {
              tokenCount: 0,
              roleId: null,
              event: null,
              message: null,
            };
            const source = new EventSource(stream.streamUrl);

            source.addEventListener("token", (event) => {
              const payload = JSON.parse(event.data);
              summary.tokenCount += 1;
              summary.roleId = payload.roleId ?? null;
            });

            source.addEventListener("message_done", (event) => {
              const payload = JSON.parse(event.data);
              summary.event = "message_done";
              summary.roleId = payload.roleId ?? null;
              source.close();
              resolve(summary);
            });

            source.addEventListener("error", (event) => {
              try {
                const payload = JSON.parse(event.data);
                summary.event = "error";
                summary.message = payload.message ?? "流式失败";
              } catch {
                summary.event = "error";
                summary.message = "流式失败";
              }
              source.close();
              resolve(summary);
            });
          });

          const messages = await window.rpChat.listMessages(chat.id);
          return {
            bootstrapCharacterCount: bootstrap.characters.length,
            bootstrapChatCount: bootstrap.chats.length,
            settings,
            stream,
            streamSummary,
            finalMessages: messages.slice(-2),
          };
        })();
      `, true);

      console.log(JSON.stringify(result, null, 2));
      safeExit(0);
    } catch (error) {
      console.error(error);
      safeExit(1);
    }
  });
});

setTimeout(() => {
  console.error("Electron integration timed out");
  safeExit(1);
}, 60000);

await import("./dist-electron/index.js");
