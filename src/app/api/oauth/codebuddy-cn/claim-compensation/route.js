import { NextResponse } from "next/server";
import {
  executeCompensationForConnection,
  getProviderConnections,
} from "@/app/api/usage/[connectionId]/compensation/route.js";

export async function POST() {
  try {
    const allConnections = await getProviderConnections();
    const cbcnConnections = (allConnections || []).filter(
      (c) => c.provider === "codebuddy-cn" && c.isActive !== false
    );

    const results = {};
    for (const conn of cbcnConnections) {
      try {
        const res = await executeCompensationForConnection(conn);
        results[conn.id] = res;
      } catch (err) {
        results[conn.id] = {
          id: conn.id,
          name: conn.name || conn.id,
          status: "failed",
          error: err.message,
          claimedAt: new Date().toISOString(),
        };
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error("[OAuth CodeBuddy CN Claim Compensation POST error]:", error);
    return NextResponse.json(
      { error: error.message || "Failed to claim compensation" },
      { status: 500 }
    );
  }
}
