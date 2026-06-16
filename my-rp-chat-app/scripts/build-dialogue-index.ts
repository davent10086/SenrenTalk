import path from "node:path";
import { createAppConfig } from "../src/backend/config";
import { ElasticsearchService } from "../src/backend/services/es/elasticsearch-service";

async function main(): Promise<void> {
  const appRoot = path.resolve(process.cwd());
  const config = createAppConfig(appRoot, path.join(appRoot, ".tmp"));
  const service = new ElasticsearchService(config);

  if (!service.enabled) {
    throw new Error("ES 未启用，请先在环境变量中提供 ES_PASSWORD 等配置。");
  }

  const result = await service.buildDialogueIndex();
  console.log(`Indexed ${result.indexedCount} dialogue documents.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
