import { NextResponse } from "next/server";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "../../../../lib/dynamo";

// ─── Types ─────────────────────────────────────────────────────────────────
interface RouteContext {
  params: Promise<{ name: string }>;
}

// ─── GET: Return approximate itemCount and sizeBytes from DescribeTable ───
// AWS refreshes these stats every ~6 hours — display with a "~" in the UI.
export async function GET(_req: Request, { params }: RouteContext) {
  const { name } = await params;

  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: name }));

  return NextResponse.json({
    itemCount: Table?.ItemCount ?? 0, // approximate, updated ~every 6 hrs
    sizeBytes: Table?.TableSizeBytes ?? 0,
  });
}
