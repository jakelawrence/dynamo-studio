import { Mastra } from "@mastra/core";
import { dynamoAgent } from "./mastra/agents/dynamoAgent";

// ─── Mastra instance ───────────────────────────────────────────────────────
// This is the single entry point for all Mastra agents in DynamoStudio.
// Import `mastra` wherever you need to call an agent (e.g. API routes).
export const mastra = new Mastra({
  agents: { dynamoAgent },
});
