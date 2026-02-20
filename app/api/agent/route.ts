import { mastra } from "../../../mastra";
import { convertFullStreamChunkToUIMessageStream, convertMastraChunkToAISDKv5 } from "@mastra/core/stream";
import { createUIMessageStreamResponse } from "ai";
import { NextRequest } from "next/server";

// ─── POST /api/agent ───────────────────────────────────────────────────────
// Accepts a chat message and the currently active table name, streams the
// agent's response back using the Vercel AI SDK data stream protocol.
//
// Request body:
//   {
//     messages: CoreMessage[],   // full conversation history
//     activeTable: string,       // table the user is currently viewing
//     schema: TableSchema | null // schema already loaded in the UI (avoids refetch)
//   }
export async function POST(req: NextRequest) {
  const { messages, activeTable, schema } = await req.json();

  const agent = mastra.getAgent("dynamoAgent");

  // Inject the active table context into the final user message so the agent
  // knows which table "this table" refers to without the user having to say it
  const systemExtension = activeTable
    ? `\n\n---\nThe user is currently viewing the table: **${activeTable}**.\n${
        schema
          ? `Its schema (already loaded): PK=${schema.pk}, SK=${schema.sk ?? "none"}, GSIs=${schema.gsi.length > 0 ? schema.gsi.join(", ") : "none"}.`
          : ""
      }\nIf they refer to "this table", "the current table", or similar, use "${activeTable}".`
    : "";

  // stream() returns MastraModelOutput. Convert it to AI SDK UI message stream
  // chunks so the frontend `useChat` transport can consume it directly.
  const stream = await agent.stream(messages, {
    // Append table context to the system prompt for this request
    instructions: systemExtension || undefined,
  });

  const mastraReader = stream.fullStream.getReader();
  const uiMessageStream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await mastraReader.read();
      if (done) {
        controller.close();
        return;
      }

      const aiPart = convertMastraChunkToAISDKv5({ chunk: value, mode: "stream" });
      if (!aiPart) return;

      const chunk = convertFullStreamChunkToUIMessageStream({
        part: aiPart as never,
        messageMetadataValue: undefined,
        sendReasoning: true,
        sendSources: true,
        onError: (error) => (error instanceof Error ? error.message : String(error)),
        sendStart: true,
        sendFinish: true,
        responseMessageId: undefined,
      });

      if (chunk) controller.enqueue(chunk);
    },
    async cancel() {
      await mastraReader.cancel();
    },
  });

  return createUIMessageStreamResponse({
    stream: uiMessageStream,
  });
}
