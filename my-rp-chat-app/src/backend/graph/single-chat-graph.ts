import { END, START, StateGraph } from "@langchain/langgraph";
import { ChatState, type ChatGraphState } from "./graph-types";

type BoundNode = (state: ChatGraphState) => Promise<Partial<ChatGraphState>>;

/** The stable graph topology, isolated from node and prompt implementation. */
export function compileSingleChatGraph(nodes: {
  prepareTurn: BoundNode;
  extractTags: BoundNode;
  retrieveContext: BoundNode;
  retrieveMemory: BoundNode;
  buildPrompt: BoundNode;
  callLlmStream: BoundNode;
  validateResponse: BoundNode;
  abortInvalidResponse: BoundNode;
  saveMessage: BoundNode;
}) {
  return new StateGraph(ChatState)
    .addNode("prepare_turn", nodes.prepareTurn)
    .addNode("extract_tags", nodes.extractTags)
    .addNode("retrieve_context", nodes.retrieveContext)
    .addNode("retrieve_memory", nodes.retrieveMemory)
    .addNode("build_prompt", nodes.buildPrompt)
    .addNode("call_llm_stream", nodes.callLlmStream)
    .addNode("validate_response", nodes.validateResponse)
    .addNode("abort_invalid_response", nodes.abortInvalidResponse)
    .addNode("save_message", nodes.saveMessage)
    .addEdge(START, "prepare_turn")
    .addEdge("prepare_turn", "extract_tags")
    .addEdge("extract_tags", "retrieve_context")
    .addEdge("retrieve_context", "retrieve_memory")
    .addEdge("retrieve_memory", "build_prompt")
    .addEdge("build_prompt", "call_llm_stream")
    .addConditionalEdges("call_llm_stream", (state: ChatGraphState) => state.skip ? END : "validate_response")
    .addConditionalEdges("validate_response", (state: ChatGraphState) => {
      if (state.validationIssue && state.retryCount <= 1) return "retrieve_context";
      return state.validationIssue ? "abort_invalid_response" : "save_message";
    })
    .addEdge("abort_invalid_response", END)
    .addEdge("save_message", END)
    .compile();
}
