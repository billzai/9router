import { NextResponse } from "next/server";
import { getUsageDashboard } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

const PERIODS = new Set(["today", "24h", "7d", "14d", "30d", "60d", "90d"]);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const periodParam = searchParams.get("period");
    // period param is accepted for backwards compat but ignored (dashboard is always fixed-window)
    const parsed = parseInt(searchParams.get("days") || "", 10);
    const days = Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 1), 365);
    const start = searchParams.get("start") || undefined;
    const end = searchParams.get("end") || undefined;
    const minRequests = parseInt(searchParams.get("minRequests") || "50", 10);

    const data = await getUsageDashboard({ minRequests: Number.isNaN(minRequests) ? 50 : minRequests });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get usage dashboard:", error);
    return NextResponse.json({ error: "Failed to fetch usage dashboard" }, { status: 500 });
  }
}
