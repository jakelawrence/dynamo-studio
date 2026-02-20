import { NextResponse } from "next/server";

export async function GET() {
  const region = process.env.AWS_REGION ?? "us-east-1";
  return NextResponse.json({ region });
}
