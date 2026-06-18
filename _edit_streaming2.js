const fs = require("fs");
const filePath = "my-rp-chat-app/src/backend/graph/chat-graphs.ts";
let code = fs.readFileSync(filePath, "utf-8");

// Normalize to LF for easier processing
const isCRLF = code.includes("\r\n");
if (isCRLF) code = code.replace(/\r\n/g, "\n");

// 1. Add pendingContextRetrieval to GraphDependencies
code = code.replace(
  "  trackAsyncJob?: (job: Promise<unknown>) => void;",
  "  trackAsyncJob?: (job: Promise<unknown>) => void;\n  pendingContextRetrieval?: Promise<RetrievedDoc[]>;"
);

// 2. In prepare_turn (first and second): fire ES search after getCharacter
const prepareReturnStart = '        character: await getCharacter({ ...state, currentRoleId }, deps.repository),\n        retrievedDocs: [],\n        memories: [],\n        output: "",\n        speechTextJa: "",\n        validationIssue: undefined,';
const prepareReturnNew = '        character: await getCharacter({ ...state, currentRoleId }, deps.repository),\n        // Fire off context retrieval in background - don\\'t await\n        deps.pendingContextRetrieval = deps.elasticsearchService.hybridSearch(\n          findLastUserMessage(state.messages)?.content ?? "",\n          { character: currentRoleId, topK: 6 }\n        ).catch(() => []);\n        retrievedDocs: [],\n        memories: [],\n        output: "",\n        speechTextJa: "",\n        validationIssue: undefined,';

code = code.replace(prepareReturnStart, prepareReturnNew);

// 3. In save_message nodes: await pendingRetrieval for metadata
const metaOld = '      const metadata: ChatMessageMetadata = {\n        retrievedCount: state.retrievedDocs.length,\n        memoryCount: state.memories.length,\n        speechTextJa: state.speechTextJa || undefined,\n      };';
const metaNew = '      const docs = await (deps.pendingContextRetrieval ?? Promise.resolve([]));\n      const metadata: ChatMessageMetadata = {\n        retrievedCount: docs.length,\n        memoryCount: state.memories.length,\n        speechTextJa: state.speechTextJa || undefined,\n      };';
code = code.replace(metaOld, metaNew);

// 4. Remove retrieve_context nodes
function removeNode(text, name) {
  let result = text;
  const pattern = '.addNode("' + name + '"';
  while (true) {
    const s = result.indexOf(pattern);
    if (s < 0) break;
    // Find the end brace
    let depth = 0;
    let foundStart = false;
    for (let i = s; i < result.length; i++) {
      if (result[i] === "{") { depth++; foundStart = true; }
      else if (result[i] === "}") { depth--; }
      if (foundStart && depth === 0 && result[i] === "}") {
        // Found the closing } of the async function body
        // Now find the closing }) of .addNode(...)
        // It should be right after on the same line: })\n
        const remaining = result.slice(i + 1);
        if (remaining.startsWith(")\n")) {
          result = result.slice(0, s) + result.slice(i + 2);
        }
        break;
      }
    }
    console.log("Removed node:", name);
  }
  return result;
}
code = removeNode(code, "retrieve_context");

// 5. Update edges: prepare_turn -> retrieve_memory (skip retrieve_context)
const edgeOld = '.addEdge("prepare_turn", "retrieve_context")\n    .addEdge("retrieve_context", "retrieve_memory")';
const edgeNew = '.addEdge("prepare_turn", "retrieve_memory")';
code = code.replace(edgeOld, edgeNew);

// 6. Convert back to CRLF if needed
if (isCRLF) code = code.replace(/\n/g, "\r\n");

fs.writeFileSync(filePath, code, "utf-8");
console.log("Done");
