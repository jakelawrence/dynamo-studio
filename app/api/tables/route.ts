import { NextResponse } from "next/server";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "../../lib/dynamo";

export async function GET() {
  const { TableNames } = await dynamo.send(new ListTablesCommand({}));
  return NextResponse.json({ tables: TableNames ?? [] });
}
