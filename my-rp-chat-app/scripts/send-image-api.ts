import fs from "node:fs";
import http from "node:http";

async function main(): Promise<void> {
  const chatId = "862d0389-c049-4882-b89a-84932e74cca8";
  const imagePath = "f:\\SenrenTalk\\my-rp-chat-app\\public\\Yoshino.jpg";
  const imageBuffer = fs.readFileSync(imagePath);

  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substr(2);

  const attachmentsMeta = JSON.stringify([
    {
      id: "test-img-1",
      kind: "image",
      originalName: "Yoshino.jpg",
      mimeType: "image/jpeg",
      size: imageBuffer.length,
    },
  ]);

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n这是谁\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nsingle\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="participants"\r\n\r\n["芳乃"]\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="attachmentsMeta"\r\n\r\n${attachmentsMeta}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="Yoshino.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    imageBuffer,
    `\r\n--${boundary}--\r\n`,
  ];

  const body = Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p)),
  );

  console.log("📤 正在发送图片消息...");
  console.log(`   chatId: ${chatId}`);
  console.log(`   content: "这是谁"`);

  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: 3001,
        path: `/api/chats/${chatId}/send`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          console.log(`\n📥 响应状态: ${response.statusCode}`);
          console.log(`📥 响应内容: ${data}`);

          if (response.statusCode === 200) {
            const result = JSON.parse(data);
            console.log(`\n✅ 消息发送成功!`);
            console.log(`   jobId: ${result.jobId}`);

            setTimeout(async () => {
              const messagesRequest = http.request(
                {
                  hostname: "127.0.0.1",
                  port: 3001,
                  path: `/api/chats/${chatId}/messages`,
                  method: "GET",
                },
                (messagesResponse) => {
                  let messagesData = "";
                  messagesResponse.on("data", (chunk) => {
                    messagesData += chunk;
                  });
                  messagesResponse.on("end", () => {
                    const messages = JSON.parse(messagesData);
                    console.log(`\n📝 消息列表:`);
                    for (const msg of messages) {
                      console.log(`   [${msg.role}] ${msg.content}`);
                    }
                    resolve();
                  });
                },
              );
              messagesRequest.end();
            }, 15000);
          } else {
            resolve();
          }
        });
      },
    );

    request.on("error", (err) => {
      console.error("\n❌ 请求失败:", err);
      resolve();
    });

    request.write(body);
    request.end();
  });
}

main();
