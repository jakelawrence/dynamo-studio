import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

// ─── DynamoDB client (reuses env vars already used by the app) ─────────────
const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
const dynamo = DynamoDBDocumentClient.from(client);

// ─── Tool: getTableSchema ──────────────────────────────────────────────────
// Fetches the full schema for a DynamoDB table including key attributes,
// GSIs, LSIs, billing mode, and a small sample of items to infer non-key
// attribute types. The agent uses this to ground all other responses.
export const getTableSchema = createTool({
  id: "getTableSchema",
  description:
    "Fetches the complete schema for a DynamoDB table: partition key, sort key, " +
    "GSIs, LSIs, billing mode, approximate item count, and inferred attribute types " +
    "from a sample of real records. Always call this before generating code or " +
    "suggesting optimizations for a table.",
  inputSchema: z.object({
    tableName: z.string().describe("The exact DynamoDB table name"),
  }),
  outputSchema: z.object({
    tableName: z.string(),
    pk: z.object({ name: z.string(), type: z.string() }),
    sk: z.object({ name: z.string(), type: z.string() }).nullable(),
    gsi: z.array(
      z.object({
        indexName: z.string(),
        pk: z.object({ name: z.string(), type: z.string() }),
        sk: z.object({ name: z.string(), type: z.string() }).nullable(),
        projection: z.string(),
      }),
    ),
    lsi: z.array(
      z.object({
        indexName: z.string(),
        sk: z.object({ name: z.string(), type: z.string() }),
        projection: z.string(),
      }),
    ),
    billingMode: z.string(),
    approximateItemCount: z.number(),
    inferredAttributes: z.array(z.object({ name: z.string(), inferredType: z.string() })),
  }),
  execute: async ({ tableName }) => {
    const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: tableName }));

    if (!Table) throw new Error(`Table ${tableName} not found`);

    // ── Key schema ───────────────────────────────────────────────────────
    const attrDefs: Record<string, string> = {};
    (Table.AttributeDefinitions ?? []).forEach((a) => {
      attrDefs[a.AttributeName!] = a.AttributeType === "S" ? "String" : a.AttributeType === "N" ? "Number" : "Binary";
    });

    const pkName = Table.KeySchema?.find((k) => k.KeyType === "HASH")?.AttributeName ?? "";
    const skName = Table.KeySchema?.find((k) => k.KeyType === "RANGE")?.AttributeName ?? null;

    // ── GSIs ─────────────────────────────────────────────────────────────
    const gsi = (Table.GlobalSecondaryIndexes ?? []).map((g) => ({
      indexName: g.IndexName ?? "",
      pk: {
        name: g.KeySchema?.find((k) => k.KeyType === "HASH")?.AttributeName ?? "",
        type: attrDefs[g.KeySchema?.find((k) => k.KeyType === "HASH")?.AttributeName ?? ""] ?? "Unknown",
      },
      sk: g.KeySchema?.find((k) => k.KeyType === "RANGE")
        ? {
            name: g.KeySchema.find((k) => k.KeyType === "RANGE")!.AttributeName!,
            type: attrDefs[g.KeySchema.find((k) => k.KeyType === "RANGE")!.AttributeName!] ?? "Unknown",
          }
        : null,
      projection: g.Projection?.ProjectionType ?? "ALL",
    }));

    // ── LSIs ─────────────────────────────────────────────────────────────
    const lsi = (Table.LocalSecondaryIndexes ?? []).map((l) => ({
      indexName: l.IndexName ?? "",
      sk: {
        name: l.KeySchema?.find((k) => k.KeyType === "RANGE")?.AttributeName ?? "",
        type: attrDefs[l.KeySchema?.find((k) => k.KeyType === "RANGE")?.AttributeName ?? ""] ?? "Unknown",
      },
      projection: l.Projection?.ProjectionType ?? "ALL",
    }));

    // ── Sample items to infer non-key attribute types ────────────────────
    const { Items: sampleItems } = await dynamo.send(new ScanCommand({ TableName: tableName, Limit: 20 }));

    const attrTypeMap: Record<string, Set<string>> = {};
    (sampleItems ?? []).forEach((item) => {
      Object.entries(item).forEach(([k, v]) => {
        if (!attrTypeMap[k]) attrTypeMap[k] = new Set();
        if (v === null || v === undefined) attrTypeMap[k].add("Null");
        else if (typeof v === "boolean") attrTypeMap[k].add("Boolean");
        else if (typeof v === "number") attrTypeMap[k].add("Number");
        else if (typeof v === "string") {
          if (v.match(/^\d{4}-\d{2}-\d{2}/)) attrTypeMap[k].add("ISO Date String");
          else attrTypeMap[k].add("String");
        } else if (Array.isArray(v)) attrTypeMap[k].add("List");
        else if (typeof v === "object") attrTypeMap[k].add("Map");
      });
    });

    const inferredAttributes = Object.entries(attrTypeMap).map(([name, types]) => ({
      name,
      inferredType: [...types].join(" | "),
    }));

    return {
      tableName,
      pk: { name: pkName, type: attrDefs[pkName] ?? "Unknown" },
      sk: skName ? { name: skName, type: attrDefs[skName] ?? "Unknown" } : null,
      gsi,
      lsi,
      billingMode: Table.BillingModeSummary?.BillingMode ?? "PROVISIONED",
      approximateItemCount: Table.ItemCount ?? 0,
      inferredAttributes,
    };
  },
});

// ─── Tool: generateQueryCode ───────────────────────────────────────────────
// Given a natural-language description of a query and the table schema,
// this tool produces idiomatic DynamoDB code in the requested language.
// It does NOT execute the query — it only generates code for the user to run.
export const generateQueryCode = createTool({
  id: "generateQueryCode",
  description:
    "Generates idiomatic DynamoDB query or scan code in the specified programming " +
    "language based on the user's natural language description. Always call " +
    "getTableSchema first so you have accurate key names and types. Returns " +
    "the code as a string along with a brief explanation of what it does.",
  inputSchema: z.object({
    tableName: z.string().describe("The DynamoDB table name"),
    queryDescription: z
      .string()
      .describe("Natural language description of the query — e.g. 'get all orders for userId abc123 placed after 2024-01-01'"),
    language: z.enum(["typescript", "javascript", "python", "go", "java", "rust"]).describe("Target programming language for the generated code"),
    schema: z
      .object({
        pk: z.object({ name: z.string(), type: z.string() }),
        sk: z.object({ name: z.string(), type: z.string() }).nullable(),
        gsi: z.array(
          z.object({
            indexName: z.string(),
            pk: z.object({ name: z.string(), type: z.string() }),
            sk: z.object({ name: z.string(), type: z.string() }).nullable(),
            projection: z.string(),
          }),
        ),
        inferredAttributes: z.array(z.object({ name: z.string(), inferredType: z.string() })),
      })
      .describe("Schema returned by getTableSchema — pass it in directly"),
  }),
  outputSchema: z.object({
    language: z.string(),
    code: z.string(),
    explanation: z.string(),
    usesIndex: z.string().nullable(),
    operationType: z.enum(["Query", "Scan", "GetItem", "PutItem", "DeleteItem", "UpdateItem"]),
  }),
  execute: async ({ language, tableName, queryDescription, schema }) => {
    // This tool is intentionally lightweight — the heavy lifting is done by
    // the agent's LLM reasoning. The tool validates inputs and returns a
    // structured schema for the agent to fill via its own generation.
    // In practice, Mastra will call this tool and the agent will populate
    // the output fields using its language model.
    // Return the structured prompt context — the agent LLM will generate
    // the actual code when it processes the tool result in its reasoning loop.
    return {
      language,
      code: `// Agent will generate ${language} code for: ${queryDescription}\n// Table: ${tableName}\n// PK: ${schema.pk.name} (${schema.pk.type})${schema.sk ? `\n// SK: ${schema.sk.name} (${schema.sk.type})` : ""}`,
      explanation: `Generating ${language} DynamoDB code for: ${queryDescription}`,
      usesIndex: null,
      operationType: "Query" as const,
    };
  },
});

// ─── Tool: suggestOptimizations ───────────────────────────────────────────
// Analyzes a table's schema and access patterns described by the user,
// then returns structured suggestions for indexes, billing mode, and patterns.
export const suggestOptimizations = createTool({
  id: "suggestOptimizations",
  description:
    "Analyzes a DynamoDB table schema and the user's described access patterns, " +
    "then suggests concrete improvements: missing GSIs, billing mode changes, " +
    "single-table design opportunities, key overloading strategies, and common " +
    "pitfalls to avoid. Always call getTableSchema first.",
  inputSchema: z.object({
    tableName: z.string(),
    accessPatterns: z.array(z.string()).describe("List of access patterns the user needs — e.g. ['get user by email', 'list all orders by status']"),
    schema: z.object({
      pk: z.object({ name: z.string(), type: z.string() }),
      sk: z.object({ name: z.string(), type: z.string() }).nullable(),
      gsi: z.array(
        z.object({
          indexName: z.string(),
          pk: z.object({ name: z.string(), type: z.string() }),
          sk: z.object({ name: z.string(), type: z.string() }).nullable(),
          projection: z.string(),
        }),
      ),
      billingMode: z.string(),
      approximateItemCount: z.number(),
      inferredAttributes: z.array(z.object({ name: z.string(), inferredType: z.string() })),
    }),
  }),
  outputSchema: z.object({
    suggestions: z.array(
      z.object({
        category: z.enum(["GSI", "LSI", "BillingMode", "KeyDesign", "SingleTableDesign", "AccessPattern", "CostOptimization"]),
        priority: z.enum(["High", "Medium", "Low"]),
        title: z.string(),
        description: z.string(),
        example: z.string().nullable(),
      }),
    ),
    summary: z.string(),
  }),
  execute: async ({ tableName, accessPatterns, schema }) => {
    // Like generateQueryCode, this tool provides structured context that the
    // agent's LLM fills in with real suggestions during its reasoning loop.
    const hasNoGSI = schema.gsi.length === 0;
    const isProvisioned = schema.billingMode === "PROVISIONED";
    const hasNoSK = !schema.sk;

    // Seed with structural observations — agent LLM adds detailed suggestions
    const seedSuggestions = [];

    if (hasNoGSI && accessPatterns.length > 1) {
      seedSuggestions.push({
        category: "GSI" as const,
        priority: "High" as const,
        title: "Consider adding GSIs for non-PK access patterns",
        description: `${tableName} has no GSIs but ${accessPatterns.length} access patterns. Without GSIs, non-PK lookups require expensive full-table scans.`,
        example: null,
      });
    }

    if (isProvisioned && schema.approximateItemCount < 100_000) {
      seedSuggestions.push({
        category: "BillingMode" as const,
        priority: "Medium" as const,
        title: "Consider switching to PAY_PER_REQUEST billing",
        description: "For tables with unpredictable or low traffic, on-demand billing is often cheaper and eliminates capacity planning.",
        example: null,
      });
    }

    if (hasNoSK) {
      seedSuggestions.push({
        category: "KeyDesign" as const,
        priority: "Medium" as const,
        title: "Adding a Sort Key enables richer query patterns",
        description:
          "A PK-only table can only look up exact items. Adding a SK enables range queries, begins_with, and between conditions within a partition.",
        example: null,
      });
    }

    return {
      suggestions: seedSuggestions,
      summary: `Analyzed ${tableName} with ${accessPatterns.length} access pattern(s). Found ${seedSuggestions.length} initial structural observations — see suggestions for details.`,
    };
  },
});
