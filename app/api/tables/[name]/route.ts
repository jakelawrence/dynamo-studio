import { NextResponse } from "next/server";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "../../../lib/dynamo";

// ─── Types ─────────────────────────────────────────────────────────────────
interface RouteContext {
  params: Promise<{ name: string }>;
}

// ─── GET: Describe table schema ────────────────────────────────────────────
export async function GET(_req: Request, { params }: RouteContext) {
  const { name } = await params;

  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: name }));

  const pk = Table?.KeySchema?.find((k) => k.KeyType === "HASH")?.AttributeName ?? "";
  const sk = Table?.KeySchema?.find((k) => k.KeyType === "RANGE")?.AttributeName ?? null;
  const gsi = Table?.GlobalSecondaryIndexes?.map((g) => g.IndexName ?? "") ?? [];

  return NextResponse.json({ pk, sk, gsi });
}
