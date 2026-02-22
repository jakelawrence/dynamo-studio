import { NextResponse } from "next/server";
import { DescribeTableCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo } from "../../../lib/dynamo";

interface VisualizerField {
  name: string;
  type: string;
  source: "key" | "inferred";
}

interface VisualizerTable {
  name: string;
  pk: string;
  sk: string | null;
  gsi: string[];
  fields: VisualizerField[];
}

function inferType(value: unknown): string {
  if (value === null || value === undefined) return "Null";
  if (typeof value === "string") return "String";
  if (typeof value === "number") return "Number";
  if (typeof value === "boolean") return "Boolean";
  if (Array.isArray(value)) return "List";
  if (typeof value === "object") return "Map";
  return "Unknown";
}

function buildTypeMap(items: Record<string, unknown>[]): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (!map[key]) map[key] = new Set<string>();
      map[key].add(inferType(value));
    }
  }
  return map;
}

function toFriendlyType(dynamoType?: string): string {
  if (!dynamoType) return "Unknown";
  if (dynamoType === "S") return "String";
  if (dynamoType === "N") return "Number";
  if (dynamoType === "B") return "Binary";
  return dynamoType;
}

export async function GET() {
  try {
    const { TableNames } = await dynamo.send(new ListTablesCommand({}));
    const tableNames = TableNames ?? [];

    const tables = await Promise.all(
      tableNames.map(async (tableName): Promise<VisualizerTable> => {
        const describe = await dynamo.send(new DescribeTableCommand({ TableName: tableName }));
        const table = describe.Table;

        const attributeDefinitions = table?.AttributeDefinitions ?? [];
        const attrTypes = new Map(attributeDefinitions.map((a) => [a.AttributeName ?? "", toFriendlyType(a.AttributeType)]));

        const pk = table?.KeySchema?.find((k) => k.KeyType === "HASH")?.AttributeName ?? "";
        const sk = table?.KeySchema?.find((k) => k.KeyType === "RANGE")?.AttributeName ?? null;
        const gsi = table?.GlobalSecondaryIndexes?.map((g) => g.IndexName ?? "").filter(Boolean) ?? [];

        let scanItems: Record<string, unknown>[] = [];
        try {
          const scan = await dynamo.send(new ScanCommand({ TableName: tableName, Limit: 25 }));
          scanItems = (scan.Items ?? []) as Record<string, unknown>[];
        } catch {
          scanItems = [];
        }

        const inferredTypeMap = buildTypeMap(scanItems);
        const fieldsMap = new Map<string, VisualizerField>();

        for (const [name, type] of attrTypes.entries()) {
          if (!name) continue;
          fieldsMap.set(name, { name, type, source: "key" });
        }

        for (const [name, typeSet] of Object.entries(inferredTypeMap)) {
          const inferredType = Array.from(typeSet).join(" | ");
          const existing = fieldsMap.get(name);
          if (existing) {
            fieldsMap.set(name, { ...existing, type: existing.type || inferredType });
          } else {
            fieldsMap.set(name, { name, type: inferredType, source: "inferred" });
          }
        }

        if (pk && !fieldsMap.has(pk)) fieldsMap.set(pk, { name: pk, type: "String", source: "key" });
        if (sk && !fieldsMap.has(sk)) fieldsMap.set(sk, { name: sk, type: "String", source: "key" });

        const fields = Array.from(fieldsMap.values()).sort((a, b) => a.name.localeCompare(b.name));

        return {
          name: tableName,
          pk,
          sk,
          gsi,
          fields,
        };
      }),
    );

    return NextResponse.json({ tables });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch visualizer schema";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
