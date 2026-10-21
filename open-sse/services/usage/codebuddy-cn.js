/**
 * CodeBuddy CN usage handler
 *
 * Scoped to the "codebuddy-cn" provider specifically — a future "codebuddy-intl"
 * variant would get its own handler/endpoint, so keep this CN-only.
 *
 * Quota lives behind a Tencent billing endpoint (POST, payload wrapped twice
 * under data.Response.Data). It mixes two credit types that must NOT be merged:
 *
 *  - Refill / base ("基础体验包"): a recurring allowance whose cycle resets long
 *    before the resource itself expires (CycleEndTime << DeductionEndTime). The
 *    live numbers live in the *Cycle* fields (e.g. CycleCapacityUsed 6.54 / 500)
 *    and resetAt is the next monthly refresh.
 *  - Bonus ("活动赠送包"): one-shot credits that run a single cycle and then
 *    expire for good (CycleEndTime == DeductionEndTime). Numbers live in the
 *    plain Capacity fields.
 *
 * We surface one quota row per package — a cadence label (Monthly/Weekly/Daily)
 * for refill packs, "Bonus Pack N" for bonus packs (soonest-expiring first).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../providers/index.js";
import { U, parseResetTime } from "./shared.js";

const PROVIDER_ID = "codebuddy-cn";

// Prefer the *Precise string fields (exact), fall back to the numeric ones.
function num(precise, plain) {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

// Label a refill pack by its cycle length (Monthly is the common CodeBuddy case).
function refillCadence(acc) {
  const start = parseResetTime(acc.CycleStartTime);
  const end = parseResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

async function getCodeBuddyUsage(providerId, accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: `CodeBuddy (${providerId}) credential not available.` };
  }

  try {
    const response = await proxyAwareFetch(U(providerId).url, {
      method: "POST",
      headers: {
        ...(PROVIDERS[providerId]?.headers || {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "CodeBuddy CN credential invalid or expired." };
    }
    if (!response.ok) {
      return { message: `CodeBuddy CN quota API error (${response.status}).` };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      return { message: `CodeBuddy CN quota error: ${json?.msg || "unknown"}` };
    }

    const data = json?.data?.Response?.Data || {};
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    if (accounts.length === 0) {
      return { message: "CodeBuddy CN connected. No credit package found." };
    }

    const cycleEndMs = (acc) => {
      const r = parseResetTime(acc.CycleEndTime);
      return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
    };
    // Refill packs roll into a new cycle before the resource expires; bonus packs
    // end exactly at expiry. >2d gap between cycle end and validity end = refill.
    const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
    const isRefill = (acc) => {
      const ce = cycleEndMs(acc);
      const de = Number(acc.DeductionEndTime);
      return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
    };
    const byExpiry = (a, b) => cycleEndMs(a) - cycleEndMs(b);

    const refills = accounts.filter(isRefill).sort(byExpiry);
    const bonuses = accounts.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas = {};
    // Refill packs first: cadence-labelled, using the *Cycle* balance and
    // resetting at the next refresh.
    const seenRefill = {};
    refills.forEach((acc) => {
      const base = refillCadence(acc);
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        // Recurring allowance: the CycleEndTime is the next refresh, not the
        // final expiry. The UI must show "Resets in", not "Expires in".
        recurring: true,
      };
    });
    // Bonus packs: use the lifetime Capacity balance; resetAt is the expiry.
    // These are one-shot credits (CycleEndTime == DeductionEndTime), so they
    // never replenish — mark recurring:false so the UI shows "Expires in"
    // instead of implying a monthly refill.
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        recurring: false,
      };
    });

    const basePkg = refills[0] || accounts[0] || {};
    const plan = basePkg.PackageName || basePkg.SubProductName || "CodeBuddy";

    let totalCapacity = 0;
    let totalUsed = 0;
    accounts.forEach((acc) => {
      if (isRefill(acc)) {
        totalCapacity += num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize);
        totalUsed += num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed);
      } else {
        totalCapacity += num(acc.CapacitySizePrecise, acc.CapacitySize);
        totalUsed += num(acc.CapacityUsedPrecise, acc.CapacityUsed);
      }
    });
    const totalRemaining = Math.max(0, totalCapacity - totalUsed);

    return {
      plan,
      quotas,
      summary: {
        totalCapacity: Number(totalCapacity.toFixed(2)),
        totalUsed: Number(totalUsed.toFixed(2)),
        totalRemaining: Number(totalRemaining.toFixed(2)),
      },
    };
  } catch (error) {
    return { message: `CodeBuddy (${providerId}) error: ${error.message}` };
  }
}

export async function getCodeBuddyCnUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage(PROVIDER_ID, accessToken, apiKey, providerSpecificData, proxyOptions);
}

export async function getCodeBuddyIntlUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage("codebuddy-intl", accessToken, apiKey, providerSpecificData, proxyOptions);
}

export async function dailyCheckinCodeBuddy(accessToken, apiKey, providerSpecificData = {}, proxyOptions = null) {
  const token = accessToken || apiKey;
  if (!token) {
    return { ok: false, message: "CodeBuddy credential not available." };
  }

  const endpoints = [
    "https://www.codebuddy.cn/v2/billing/meter/daily-checkin",
    "https://copilot.tencent.com/v2/billing/meter/daily-checkin",
  ];

  const headers = {
    ...(PROVIDERS[PROVIDER_ID]?.headers || {}),
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(providerSpecificData?.uid ? { "X-User-Id": String(providerSpecificData.uid) } : {}),
    ...(providerSpecificData?.enterpriseId ? {
      "X-Enterprise-Id": String(providerSpecificData.enterpriseId),
      "X-Tenant-Id": String(providerSpecificData.enterpriseId),
    } : {}),
    ...(providerSpecificData?.domain ? { "X-Domain": String(providerSpecificData.domain) } : {}),
  };

  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: "{}",
      }, proxyOptions);

      const text = await response.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch (_) {}

      const code = json?.code;
      const msg = json?.msg || text;
      const isAlready = code === 10001 || /已签到|已领取|已经.*(?:签到|领取)|重复签到|already/i.test(msg);
      const isSuccess = (code === 0 && response.ok) || isAlready;

      return {
        ok: isSuccess,
        already: isAlready,
        code,
        message: msg || (isSuccess ? "Success" : `HTTP ${response.status}`),
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    message: lastError ? lastError.message : "Checkin failed",
  };
}

export function decodeJwtSub(jwt) {
  if (!jwt || typeof jwt !== "string") return null;
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const jsonPayload = Buffer.from(pad, "base64").toString("utf-8");
    const payload = JSON.parse(jsonPayload);
    return payload.sub || payload.uid || payload.userId || null;
  } catch (_) {
    return null;
  }
}

const COMPENSATION_STATUS_URLS = [
  "https://www.codebuddy.cn/billing/meter/compensation-status",
  "https://copilot.tencent.com/billing/meter/compensation-status",
];

const GIFT_STATUS_URLS = [
  "https://www.codebuddy.cn/billing/meter/check-gift-claimed",
  "https://copilot.tencent.com/billing/meter/check-gift-claimed",
];

const CLAIM_COMPENSATION_URLS = [
  "https://www.codebuddy.cn/billing/meter/claim-compensation",
  "https://copilot.tencent.com/billing/meter/claim-compensation",
];

const CLAIM_GIFT_URLS = [
  "https://www.codebuddy.cn/billing/meter/claim-gift",
  "https://copilot.tencent.com/billing/meter/claim-gift",
];

async function postCnEndpoint(urls, headers, proxyOptions) {
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await proxyAwareFetch(
        url,
        {
          method: "POST",
          headers,
          body: "{}",
        },
        proxyOptions
      );

      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_) {}

      return {
        ok: response.ok,
        status: response.status,
        code: json?.code ?? json?.error_code,
        msg: json?.msg ?? json?.message ?? text,
        data: json?.data?.Response?.Data ?? json?.data ?? {},
        raw: json,
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    status: 500,
    code: -1,
    msg: lastError ? lastError.message : "Request failed",
    data: {},
    raw: null,
  };
}

export async function claimCodeBuddyCompensation(
  accessToken,
  apiKey,
  providerSpecificData = {},
  proxyOptions = null
) {
  const token = accessToken || apiKey;
  if (!token) {
    return { status: "unauthorized", code: 401, message: "CodeBuddy credential not available." };
  }

  const uid = providerSpecificData?.uid || decodeJwtSub(token);
  const headers = {
    ...(PROVIDERS[PROVIDER_ID]?.headers || {}),
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(uid ? { "X-User-Id": String(uid) } : {}),
    ...(providerSpecificData?.enterpriseId
      ? {
          "X-Enterprise-Id": String(providerSpecificData.enterpriseId),
          "X-Tenant-Id": String(providerSpecificData.enterpriseId),
        }
      : {}),
    ...(providerSpecificData?.domain ? { "X-Domain": String(providerSpecificData.domain) } : {}),
  };

  // 1. 查询 COMPENSATION_STATUS_URLS
  const compStatusRes = await postCnEndpoint(COMPENSATION_STATUS_URLS, headers, proxyOptions);
  if (compStatusRes.status === 401 || compStatusRes.code === 401) {
    return { status: "unauthorized", code: 401, message: compStatusRes.msg || "CodeBuddy CN credential invalid or expired." };
  }

  // 2. 查询 GIFT_STATUS_URLS (best-effort)
  let giftStatusRes = null;
  try {
    giftStatusRes = await postCnEndpoint(GIFT_STATUS_URLS, headers, proxyOptions);
    if (giftStatusRes.status === 401 || giftStatusRes.code === 401) {
      return { status: "unauthorized", code: 401, message: giftStatusRes.msg || "CodeBuddy CN credential invalid or expired." };
    }
  } catch (_) {}

  if (!compStatusRes.ok && compStatusRes.status !== 200) {
    return {
      status: "failed",
      error: compStatusRes.msg || `http_${compStatusRes.status}`,
      message: `Failed to query compensation status: ${compStatusRes.msg || compStatusRes.status}`,
    };
  }

  const compData = compStatusRes.data || {};
  const giftData = giftStatusRes?.data || {};

  let totalClaimed = 0;
  const claimedDetails = [];
  let anyClaimFailed = false;
  let lastClaimError = null;

  // 3. 如果 compData.active === true && !compData.claimed
  if (compData.active === true && !compData.claimed) {
    const claimRes = await postCnEndpoint(CLAIM_COMPENSATION_URLS, headers, proxyOptions);
    if (claimRes.status === 401 || claimRes.code === 401) {
      return { status: "unauthorized", code: 401, message: claimRes.msg || "CodeBuddy CN credential invalid or expired." };
    }
    if (claimRes.ok && (claimRes.code === 0 || claimRes.code === "0")) {
      const amount = Number(claimRes.data?.credit_num || compData.credit_num || compData.amount || 0);
      totalClaimed += amount;
      claimedDetails.push({ type: "compensation", amount, endTime: compData.end_time || null });
    } else {
      anyClaimFailed = true;
      lastClaimError = claimRes.msg || `http_${claimRes.status}`;
    }
  }

  // 4. 如果 giftData.active === true && !giftData.claimed
  if (giftData.active === true && !giftData.claimed) {
    const giftClaimRes = await postCnEndpoint(CLAIM_GIFT_URLS, headers, proxyOptions);
    if (giftClaimRes.status === 401 || giftClaimRes.code === 401) {
      return { status: "unauthorized", code: 401, message: giftClaimRes.msg || "CodeBuddy CN credential invalid or expired." };
    }
    if (giftClaimRes.ok && (giftClaimRes.code === 0 || giftClaimRes.code === "0")) {
      const amount = Number(giftClaimRes.data?.credit_num || giftData.credit_num || giftData.amount || 0);
      totalClaimed += amount;
      claimedDetails.push({ type: "gift", amount, endTime: giftData.end_time || null });
    } else {
      anyClaimFailed = true;
      lastClaimError = giftClaimRes.msg || `http_${giftClaimRes.status}`;
    }
  }

  // 5. 累计 claimedAmount 并返回统一状态
  if (totalClaimed > 0) {
    return {
      status: "claimed",
      claimedAmount: totalClaimed,
      details: claimedDetails,
      message: `成功领取 ${totalClaimed} 积分/额度`,
    };
  }

  if (anyClaimFailed) {
    return {
      status: "failed",
      error: lastClaimError || "claim_failed",
      message: `领取失败: ${lastClaimError || "claim_failed"}`,
    };
  }

  const isCompAlready = compData.claimed === true || (compData.active === true && compData.claimed);
  const isGiftAlready = giftData.claimed === true || (giftData.active === true && giftData.claimed);
  if (isCompAlready || isGiftAlready) {
    return {
      status: "already",
      claimedAmount: 0,
      message: "补偿与礼包已全部领取",
    };
  }

  if (compData.active === false && (!giftData || giftData.active === false)) {
    return {
      status: "no-activity",
      claimedAmount: 0,
      message: "当前暂无补偿或礼包活动",
    };
  }

  return {
    status: "already",
    claimedAmount: 0,
    message: "已领取或无需重复领取",
  };
}
