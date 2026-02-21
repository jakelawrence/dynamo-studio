import { NextRequest, NextResponse } from "next/server";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo } from "../../../lib/dynamo";

type PrimitiveType = "string" | "number" | "boolean";
type Operation = "Query" | "Scan" | "GetItem" | "PutItem" | "UpdateItem" | "DeleteItem";

interface ExecInput {
  name: string;
  type: PrimitiveType;
  required?: boolean;
}

interface ExecPayload {
  type: "dynamo-exec";
  operation: Operation;
  tableName?: string;
  inputSchema?: ExecInput[];
  scanMode?: "full" | "target";
  maxMatchedRows?: number;
  scanPageSize?: number;
  params: Record<string, unknown>;
}

interface ExecuteRequest {
  activeTable?: string;
  payload: ExecPayload;
  inputs?: Record<string, unknown>;
}

const PLACEHOLDER = /^{{\s*([a-zA-Z0-9_]+)\s*}}$/;

function coerceInputValue(value: unknown, type: PrimitiveType): unknown {
  if (type === "string") return String(value ?? "");

  if (type === "number") {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(numberValue)) throw new Error(`Expected a number but got: ${String(value)}`);
    return numberValue;
  }

  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`Expected a boolean but got: ${String(value)}`);
}

function buildResolvedInputs(inputSchema: ExecInput[] | undefined, rawInputs: Record<string, unknown> | undefined): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  const source = rawInputs ?? {};

  for (const field of inputSchema ?? []) {
    const raw = source[field.name];
    if (field.required && (raw === undefined || raw === null || raw === "")) {
      throw new Error(`Missing required input: ${field.name}`);
    }
    if (raw === undefined || raw === null || raw === "") continue;
    resolved[field.name] = coerceInputValue(raw, field.type);
  }

  // Keep extra ad-hoc inputs as strings for placeholder replacement
  Object.entries(source).forEach(([key, value]) => {
    if (resolved[key] !== undefined) return;
    if (value === undefined || value === null) return;
    resolved[key] = value;
  });

  return resolved;
}

function resolveTemplateValue(value: unknown, inputs: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry, inputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveTemplateValue(v, inputs)]));
  }

  if (typeof value !== "string") return value;

  const directMatch = value.match(PLACEHOLDER);
  if (directMatch) {
    const key = directMatch[1];
    if (!(key in inputs)) throw new Error(`Missing input value for placeholder: ${key}`);
    return inputs[key];
  }

  return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) => {
    if (!(key in inputs)) throw new Error(`Missing input value for placeholder: ${key}`);
    return String(inputs[key]);
  });
}

function withTableName(params: Record<string, unknown>, tableName: string): Record<string, unknown> {
  return {
    ...params,
    TableName: tableName,
  };
}

function toSafePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

export async function POST(req: NextRequest) {
  try {
    console.log("🚀 [execute] POST request received");
    const { activeTable, payload, inputs }: ExecuteRequest = await req.json();
    console.log("📥 [execute] Request data:", { activeTable, payload, inputs });

    if (!payload || payload.type !== "dynamo-exec") {
      console.error("❌ [execute] Invalid payload:", payload);
      return NextResponse.json({ error: "Invalid payload. Expected a dynamo-exec payload." }, { status: 400 });
    }

    const tableName = payload.tableName || activeTable;
    if (!tableName) {
      console.error("❌ [execute] No table name provided");
      return NextResponse.json({ error: "No table name provided in payload or activeTable." }, { status: 400 });
    }
    console.log("📋 [execute] Table name:", tableName);

    const resolvedInputs = buildResolvedInputs(payload.inputSchema, inputs as Record<string, unknown> | undefined);
    console.log("🔧 [execute] Resolved inputs:", resolvedInputs);
    const resolvedParams = resolveTemplateValue(payload.params, resolvedInputs) as Record<string, unknown>;
    console.log("⚙️ [execute] Resolved params:", resolvedParams);

    let result: Record<string, unknown>;

    switch (payload.operation) {
      case "Query": {
        console.log("🔍 [execute] Executing Query operation");
        const requestedLimit = typeof resolvedParams.Limit === "number" ? resolvedParams.Limit : Number(resolvedParams.Limit ?? 50);
        const safeLimit = Math.min(Math.max(Number.isNaN(requestedLimit) ? 50 : requestedLimit, 1), 200);
        console.log("📊 [execute] Query limit:", safeLimit);
        result = await dynamo.send(new QueryCommand(withTableName({ ...resolvedParams, Limit: safeLimit }, tableName) as any));
        console.log("✅ [execute] Query result rows:", ((result as any).Items?.length ?? 0) as number);
        break;
      }
      case "Scan": {
        console.log("🔍 [execute] Executing Scan operation");
        const scanMode = payload.scanMode ?? "target";
        const targetMatches = toSafePositiveInt(payload.maxMatchedRows ?? resolvedParams.Limit, 200, 2000);
        const pageSize = toSafePositiveInt(payload.scanPageSize ?? 200, 200, 200);

        const scanBaseParams: Record<string, unknown> = { ...resolvedParams };
        delete scanBaseParams.Limit;
        delete scanBaseParams.PageSize;

        let lastEvaluatedKey = scanBaseParams.ExclusiveStartKey;
        delete scanBaseParams.ExclusiveStartKey;

        const collected: Record<string, unknown>[] = [];
        let scannedCount = 0;
        let pageCount = 0;

        console.log("📊 [execute] Scan config:", { scanMode, targetMatches, pageSize });

        do {
          const pageResult = await dynamo.send(
            new ScanCommand(
              withTableName(
                {
                  ...scanBaseParams,
                  ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
                  Limit: pageSize,
                },
                tableName,
              ) as any,
            ),
          );

          pageCount += 1;
          scannedCount += pageResult.ScannedCount ?? 0;
          if (Array.isArray(pageResult.Items) && pageResult.Items.length > 0) {
            collected.push(...(pageResult.Items as Record<string, unknown>[]));
          }

          lastEvaluatedKey = pageResult.LastEvaluatedKey;

          if (scanMode === "target" && collected.length >= targetMatches) {
            break;
          }
        } while (lastEvaluatedKey);

        const rows = scanMode === "target" ? collected.slice(0, targetMatches) : collected;
        const truncated = scanMode === "target" && collected.length > rows.length;

        result = {
          Items: rows,
          Count: rows.length,
          LastEvaluatedKey: scanMode === "target" && rows.length >= targetMatches ? lastEvaluatedKey : undefined,
          ScannedCount: scannedCount,
          $meta: {
            scanMode,
            pageCount,
            targetMatches: scanMode === "target" ? targetMatches : null,
            pageSize,
            truncated,
          },
        };

        console.log("✅ [execute] Scan completed:", {
          pageCount,
          scannedCount,
          returnedRows: rows.length,
          hasMore: Boolean(lastEvaluatedKey),
          scanMode,
        });
        break;
      }
      case "GetItem":
        console.log("🔍 [execute] Executing GetItem operation");
        result = await dynamo.send(new GetCommand(withTableName(resolvedParams, tableName) as any));
        console.log("✅ [execute] GetItem result:", !!result.Item);
        break;
      case "PutItem":
        console.log("✏️ [execute] Executing PutItem operation");
        result = await dynamo.send(new PutCommand(withTableName(resolvedParams, tableName) as any));
        console.log("✅ [execute] PutItem completed");
        break;
      case "UpdateItem":
        console.log("✏️ [execute] Executing UpdateItem operation");
        result = await dynamo.send(new UpdateCommand(withTableName(resolvedParams, tableName) as any));
        console.log("✅ [execute] UpdateItem completed");
        break;
      case "DeleteItem":
        console.log("🗑️ [execute] Executing DeleteItem operation");
        result = await dynamo.send(new DeleteCommand(withTableName(resolvedParams, tableName) as any));
        console.log("✅ [execute] DeleteItem completed");
        break;
      default:
        console.error("❌ [execute] Unsupported operation:", payload.operation);
        return NextResponse.json({ error: `Unsupported operation: ${String((payload as ExecPayload).operation)}` }, { status: 400 });
    }

    const rows = Array.isArray(result.Items) ? result.Items : result.Item ? [result.Item] : result.Attributes ? [result.Attributes] : [];

    console.log("📦 [execute] Final response:", { operation: payload.operation, tableName, rowCount: rows.length });
    return NextResponse.json({
      operation: payload.operation,
      tableName,
      rowCount: rows.length,
      rows,
      raw: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    console.error("💥 [execute] Error occurred:", error);
    console.error("❌ [execute] Error message:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
