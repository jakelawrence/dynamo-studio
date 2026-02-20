import { Mastra } from "@mastra/core";
import { dynamoAgent } from "./agents/dynamoAgent";

export const mastra = new Mastra({
  agents: {
    dynamoAgent,
  },
});

