// app/api/tables/[name]/items/route.ts
import { NextResponse } from "next/server";
import { ScanCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo } from "../../../../lib/dynamo";
// ─── Types ─────────────────────────────────────────────────────────────────
interface RouteContext {
  params: Promise<{ name: string }>;
}

// ─── GET: Scan items with optional pagination ─────────────────────────────
// Query params:
//   ?startKey=<urlencoded JSON>   — DynamoDB ExclusiveStartKey from previous page
//   ?limit=<number>               — max items to return (default 25)
export async function GET(req: Request, { params }: RouteContext) {
  const { name } = await params;
  const { searchParams } = new URL(req.url);

  const limit = Math.min(Number(searchParams.get("limit") ?? 25), 1000);
  const startKeyRaw = searchParams.get("startKey");
  const exclusiveStartKey = startKeyRaw ? JSON.parse(decodeURIComponent(startKeyRaw)) : undefined;

  const { Items, LastEvaluatedKey } = await dynamo.send(
    new ScanCommand({
      TableName: name,
      Limit: limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }),
  );

  return NextResponse.json({
    items: Items ?? [],
    lastKey: LastEvaluatedKey ?? null, // null = no more pages
  });
}

// ─── POST: Create or update an item ───────────────────────────────────────
export async function POST(req: Request, { params }: RouteContext) {
  const { name } = await params;
  const item = await req.json();
  await dynamo.send(new PutCommand({ TableName: name, Item: item }));
  return NextResponse.json({ success: true });
}

// ─── DELETE: Delete an item by key ────────────────────────────────────────
export async function DELETE(req: Request, { params }: RouteContext) {
  const { name } = await params;
  const { key } = await req.json();
  await dynamo.send(new DeleteCommand({ TableName: name, Key: key }));
  return NextResponse.json({ success: true });
}
