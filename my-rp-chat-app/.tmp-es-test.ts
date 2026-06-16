import path from "node:path";
import { createAppConfig } from "./src/backend/config";
import { ElasticsearchService } from "./src/backend/services/es/elasticsearch-service";

async function main() {
  const appRoot = process.cwd();
  const config = createAppConfig(appRoot, path.join(appRoot, ".tmp-test"));
  const es = new ElasticsearchService(config);
  const results = await es.hybridSearch("神社 祭典 开心", {
    character: "芳乃",
    topK: 5,
    tags: {
      scene: ["神社祭典"],
      emotion: ["开心喜悦"],
    },
  });
  console.log(JSON.stringify(results.slice(0, 5), null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
