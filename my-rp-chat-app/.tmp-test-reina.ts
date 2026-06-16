import { AppRuntime } from "./src/backend/app-runtime";

async function testReinaCharacter() {
  console.log("=== 测试蕾娜角色设定 ===");
  
  const runtime = new AppRuntime(
    process.cwd(),
    ".tmp-runtime"
  );
  
  try {
    await runtime.start();
    
    // 检查角色配置是否加载正确
    const characters = runtime.repository.listCharacters();
    const reina = characters.find(c => c.id === "蕾娜");
    
    if (reina) {
      console.log(`角色名称: ${reina.displayName}`);
      console.log(`身份设定: ${reina.promptProfile.identity}`);
      console.log(`自称: ${reina.promptProfile.selfAddress}`);
      console.log(`语气: ${reina.promptProfile.tone}`);
      console.log(`典型表达: ${reina.promptProfile.typicalExpressions.join("; ")}`);
      console.log(`世界知识: ${reina.promptProfile.worldKnowledge.join("; ")}`);
      
      // 验证国籍设定是否正确
      const hasSweden = reina.promptProfile.identity.includes("瑞典") || 
                        reina.promptProfile.worldKnowledge.some(k => k.includes("瑞典"));
      
      if (hasSweden) {
        console.log("\n✅ 蕾娜国籍设定正确：来自瑞典");
      } else {
        console.log("\n❌ 蕾娜国籍设定仍然错误");
      }
      
      // 创建测试会话并发送消息
      console.log("\n=== 创建测试会话 ===");
      const chat = runtime.createChat("single", ["蕾娜"], "测试蕾娜对话");
      console.log(`创建会话: ${chat.id}`);
      
      console.log("\n=== 发送测试消息 ===");
      const result = await runtime.sendMessage({
        chatId: chat.id,
        content: "蕾娜，你来自哪里呀？",
        mode: "single",
        participants: ["蕾娜"]
      });
      
      console.log(`Stream URL: ${result.streamUrl}`);
      console.log(`Stream ID: ${result.streamId}`);
      
    } else {
      console.error("❌ 未找到蕾娜角色");
    }
    
  } catch (error) {
    console.error("测试失败:", error);
  } finally {
    await runtime.dispose();
  }
}

testReinaCharacter();
