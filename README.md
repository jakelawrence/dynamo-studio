# DynamoStudio

DynamoStudio is a Next.js web app for exploring and managing AWS DynamoDB tables with an integrated AI assistant.

It combines:
- A table browser with schema and approximate table stats
- Item-level CRUD (create, edit, delete)
- Search and pagination for browsing records
- An AI chat assistant (Mastra + Anthropic) for schema explanation, query/code generation, and optimization suggestions

## What It Does

- Lists DynamoDB tables in your AWS account/region
- Displays table key schema (PK/SK) and GSIs
- Loads table items with pagination
- Lets you:
  - Add new items
  - Edit existing items
  - Delete single or multiple items
- Supports key-focused search (PK/SK-oriented search strategy)
- Shows JSON value viewer for nested attributes
- Includes an in-app AI assistant tied to the currently selected table context

## Tech Stack

- Next.js (App Router)
- React + TypeScript
- AWS SDK v3 (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`)
- Mastra agent framework
- Anthropic model via AI SDK

## Prerequisites

- Node.js 18+
- AWS account credentials with DynamoDB access
- Anthropic API key (required for the AI chat feature)

## Environment Variables

Create `.env.local` in the project root:

```bash
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### Minimum AWS IAM Permissions

The app/API use these DynamoDB operations:
- `dynamodb:ListTables`
- `dynamodb:DescribeTable`
- `dynamodb:Scan`
- `dynamodb:Query`
- `dynamodb:PutItem`
- `dynamodb:DeleteItem`

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Add `.env.local` with the variables above.

3. Start the development server:

```bash
npm run dev
```

4. Open:

[http://localhost:3000](http://localhost:3000)

## Build and Run Production

```bash
npm run build
npm run start
```

## Example Use Cases

1. Inspect a table quickly:
- Select a table from the sidebar
- Review PK/SK, GSIs, and approximate record count
- Browse records page-by-page

2. Fix bad data in-place:
- Search by key prefix/value
- Open the row editor
- Update attributes and save

3. Clean test data:
- Select multiple rows with checkboxes
- Bulk delete test items

4. Plan improvements with AI:
- Open `Ask AI`
- Prompts like:
  - “Explain this table’s schema and access patterns.”
  - “Generate a TypeScript query for all orders by userId.”
  - “What GSIs should I add for status + createdAt lookups?”

## API Overview

- `GET /api/tables` → list table names
- `GET /api/tables/[name]` → table schema summary (PK/SK/GSI names)
- `GET /api/tables/[name]/meta` → approximate `itemCount` and `sizeBytes`
- `GET /api/tables/[name]/items` → paginated item fetch/search
- `POST /api/tables/[name]/items` → create/update item
- `DELETE /api/tables/[name]/items` → delete item by key
- `GET /api/region` → current AWS region from env
- `POST /api/agent` → stream AI chat responses with active table context

## Project Structure

```text
app/
  api/
    agent/route.ts
    region/route.ts
    tables/
      route.ts
      [name]/
        route.ts
        items/route.ts
        meta/route.ts
  lib/dynamo.ts
  page.tsx
components/
  AgentChat.tsx
mastra/
  agents/dynamoAgent.ts
  tools/dynamoTools.ts
```

## Notes and Limitations

- Table counts/sizes from `DescribeTable` are approximate and not real-time.
- Search is key-focused and can fall back to scans depending on term/table shape.
- AI chat requires `ANTHROPIC_API_KEY`; without it, the core table UI still works.
- This project currently stores AWS credentials in env vars for local/dev convenience. For production, prefer IAM roles or a secure secrets manager.

## Troubleshooting

- “Failed to connect to DynamoDB”:
  - Verify AWS credentials and region in `.env.local`
  - Confirm IAM permissions listed above

- AI chat not responding:
  - Verify `ANTHROPIC_API_KEY`
  - Check server logs for `/api/agent` errors

- No tables found:
  - Confirm region points to where your tables exist

## License

No license file is currently included. Add one (for example, MIT) before open-source distribution.
