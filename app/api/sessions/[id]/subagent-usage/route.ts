import { NextResponse } from "next/server";
import { getSubagentUsage } from "@/lib/subagent-usage";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await getSubagentUsage(id));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
