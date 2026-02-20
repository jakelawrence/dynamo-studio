import { NextResponse } from "next/server";
import { ScanCommand, QueryCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "../../../../lib/dynamo";

// ─── Types ─────────────────────────────────────────────────────────────────
interface RouteContext {
  params: Promise<{ name: string }>;
}

type DynamoKey = Record<string, unknown>;

// ─── Helpers ───────────────────────────────────────────────────────────────

// Resolve the PK and SK attribute names for a table via DescribeTable.
// We call this only when a search term is present to avoid the extra RTT
// on normal paginated scans.
async function getKeySchema(tableName: string): Promise<{ pk: string; sk: string | null }> {
  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: tableName }));
  const pk = Table?.KeySchema?.find((k) => k.KeyType === "HASH")?.AttributeName ?? "";
  const sk = Table?.KeySchema?.find((k) => k.KeyType === "RANGE")?.AttributeName ?? null;
  return { pk, sk };
}

// ─── GET: Paginated scan — or PK/SK-scoped search when ?search= is provided ─
//
// Query params:
//   ?limit=<number>             — items per page (default 25, max 1000)
//   ?startKey=<urlencoded JSON> — DynamoDB ExclusiveStartKey for pagination
//   ?search=<string>            — search term scoped to PK and SK only
//
// Search strategy (fastest → slowest):
//
//   1. QueryCommand with exact KeyConditionExpression on PK
//      → Uses the B-tree index. Reads only items in that partition.
//      → O(matching items), not O(table size). Best case.
//
//   2. If step 1 returns 0 results AND the table has a SK:
//      ScanCommand with FilterExpression: begins_with(pk, term) OR begins_with(sk, term)
//      → Still a full scan but filters on indexed key attributes only,
//        which is cheaper than filtering on arbitrary non-key attributes.
//
//   3. If no SK (PK-only table):
//      ScanCommand with FilterExpression: begins_with(pk, term)
//
// In all search cases, Limit is intentionally omitted so DynamoDB evaluates
// the FilterExpression against the entire table rather than just the first N
// items. We cap the returned results client-side at `limit`.
//
// NOTE: DynamoDB contains() and begins_with() are case-sensitive. There is no
// native case-insensitive option in FilterExpression.
export async function GET(req: Request, { params }: RouteContext) {
  const { name } = await params;
  const { searchParams } = new URL(req.url);

  const limit = Math.min(Number(searchParams.get("limit") ?? 25), 1000);
  const startKeyRaw = searchParams.get("startKey");
  const exclusiveStartKey: DynamoKey | undefined = startKeyRaw ? JSON.parse(decodeURIComponent(startKeyRaw)) : undefined;
  const searchTerm = searchParams.get("search")?.trim() ?? "";

  // ── No search term → normal paginated Scan ──────────────────────────────
  if (!searchTerm) {
    const { Items, LastEvaluatedKey } = await dynamo.send(
      new ScanCommand({
        TableName: name,
        Limit: limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    return NextResponse.json({
      items: Items ?? [],
      lastKey: LastEvaluatedKey ?? null,
    });
  }

  // ── Search term present → resolve key schema first ──────────────────────
  const { pk, sk } = await getKeySchema(name);

  // ── Strategy 1: Exact PK match via QueryCommand ─────────────────────────
  // QueryCommand uses the partition key index directly — no table scan needed.
  // This is by far the fastest path and should be tried first.
  try {
    const queryResult = await dynamo.send(
      new QueryCommand({
        TableName: name,
        KeyConditionExpression: "#pk = :search",
        ExpressionAttributeNames: { "#pk": pk },
        ExpressionAttributeValues: { ":search": searchTerm },
        // No Limit here — we want all items in this partition
      }),
    );

    const exactItems = queryResult.Items ?? [];

    // If we got results, return them immediately — no scan needed
    if (exactItems.length > 0) {
      return NextResponse.json({
        items: exactItems.slice(0, limit),
        lastKey: null, // Query on exact PK returns all matches in one shot
        searchStrategy: "query-exact-pk",
      });
    }
  } catch {
    // QueryCommand can fail if the search term type doesn't match the PK type
    // (e.g. searching "123" on a numeric PK). Fall through to Scan.
  }

  // ── Strategy 2: begins_with Scan on PK (and SK if present) ──────────────
  // No Limit so FilterExpression is applied across the full table.
  // Only filters on key attributes — cheaper than filtering on arbitrary fields.
  const nameMap: Record<string, string> = { "#pk": pk };
  const conditions: string[] = [`begins_with(#pk, :search)`];

  if (sk) {
    nameMap["#sk"] = sk;
    conditions.push(`begins_with(#sk, :search)`);
  }

  const filterExpression = conditions.join(" OR ");
  const collected: DynamoItem[] = [];
  let lastEvaluatedKey: DynamoKey | undefined = exclusiveStartKey;

  // Loop through DynamoDB pages until we have `limit` results or exhaust the table.
  // Without Limit, each ScanCommand page is up to 1MB of data from DynamoDB.
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: name,
        FilterExpression: filterExpression,
        ExpressionAttributeNames: nameMap,
        ExpressionAttributeValues: { ":search": searchTerm },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    collected.push(...(result.Items ?? []));
    lastEvaluatedKey = result.LastEvaluatedKey as DynamoKey | undefined;

    if (collected.length >= limit) break;
  } while (lastEvaluatedKey);

  return NextResponse.json({
    items: collected.slice(0, limit),
    // If we broke early (hit limit) and there are more pages, surface the cursor
    lastKey: collected.length >= limit && lastEvaluatedKey ? lastEvaluatedKey : null,
    searchStrategy: "scan-begins-with-pk-sk",
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

// ─── Internal type (used in search loop above) ────────────────────────────
type DynamoItem = Record<string, unknown>;
