// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections } from "@/lib/localDb";
import { makeKv } from "@/lib/db/helpers/kvStore";
import { claimCodeBuddyCompensation } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";

const compensationKv = makeKv("codebuddy_compensation");

export async function executeCompensationForConnection(connection) {
  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  let activeConn = connection;
  try {
    const refreshed = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    if (refreshed?.connection) {
      activeConn = refreshed.connection;
    }
  } catch (err) {
    console.warn(`[Compensation] Token refresh failed for ${connection.id}:`, err.message);
  }

  let result = await claimCodeBuddyCompensation(
    activeConn.accessToken || activeConn.apiKey,
    activeConn.apiKey,
    activeConn.providerSpecificData,
    proxyOptions
  );

  if (result?.status === "unauthorized" || result?.code === 401 || result?.status === 401) {
    try {
      const forceRefreshed = await refreshAndUpdateCredentials(activeConn, true, proxyOptions);
      if (forceRefreshed?.connection) {
        activeConn = forceRefreshed.connection;
        result = await claimCodeBuddyCompensation(
          activeConn.accessToken || activeConn.apiKey,
          activeConn.apiKey,
          activeConn.providerSpecificData,
          proxyOptions
        );
      }
    } catch (err) {
      console.warn(`[Compensation] Force token refresh failed for ${connection.id}:`, err.message);
    }
  }

  const record = {
    claimedAt: new Date().toISOString(),
    status: result?.status || "failed",
    claimedAmount: Number(result?.claimedAmount) || 0,
    details: result?.details || [],
    message: result?.message || "",
    ...(result?.error ? { error: result.error } : {}),
  };

  await compensationKv.set(connection.id, record);
  return { id: connection.id, name: connection.name || connection.id, ...record };
}

export async function GET(_request, { params }) {
  try {
    const { connectionId } = await params;

    if (connectionId === "all") {
      const allRecords = await compensationKv.getAll();
      return NextResponse.json({ compensations: allRecords || {} });
    }

    const record = await compensationKv.get(connectionId, null);
    return NextResponse.json({ compensation: record });
  } catch (error) {
    console.error("[Compensation API GET error]:", error);
    return NextResponse.json({ error: "Failed to fetch compensation status" }, { status: 500 });
  }
}

export async function POST(_request, { params }) {
  try {
    const { connectionId } = await params;

    if (connectionId === "all") {
      const allConnections = await getProviderConnections();
      const cbcnConnections = (allConnections || []).filter(
        (c) => c.provider === "codebuddy-cn" && c.isActive !== false
      );

      if (cbcnConnections.length === 0) {
        return NextResponse.json({
          message: "No active CodeBuddy CN connections found",
          results: {},
          summary: { total: 0, claimed: 0, already: 0, noActivity: 0, failed: 0, totalCredits: 0 },
        });
      }

      const results = {};
      let claimed = 0;
      let already = 0;
      let noActivity = 0;
      let failed = 0;
      let totalCredits = 0;

      for (const conn of cbcnConnections) {
        try {
          const res = await executeCompensationForConnection(conn);
          results[conn.id] = res;
          if (res.status === "claimed") {
            claimed += 1;
            totalCredits += Number(res.claimedAmount) || 0;
          } else if (res.status === "already") {
            already += 1;
          } else if (res.status === "no-activity") {
            noActivity += 1;
          } else {
            failed += 1;
          }
        } catch (err) {
          results[conn.id] = {
            id: conn.id,
            name: conn.name || conn.id,
            status: "failed",
            error: err.message,
            claimedAt: new Date().toISOString(),
          };
          failed += 1;
        }
      }

      return NextResponse.json({
        success: failed === 0 || claimed > 0 || already > 0 || noActivity > 0,
        results,
        summary: {
          total: cbcnConnections.length,
          claimed,
          already,
          noActivity,
          failed,
          totalCredits,
        },
      });
    }

    const connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (connection.provider !== "codebuddy-cn") {
      return NextResponse.json(
        { error: "Compensation claim is only supported for CodeBuddy CN" },
        { status: 400 }
      );
    }

    const result = await executeCompensationForConnection(connection);
    return NextResponse.json({ success: result.status !== "failed", result });
  } catch (error) {
    console.error("[Compensation API POST error]:", error);
    return NextResponse.json({ error: error.message || "Compensation claim failed" }, { status: 500 });
  }
}

export { getProviderConnections };
