const crypto = require("crypto");

const MAX_RECORDS_PER_REQUEST = 50;
const MAX_PAYLOAD_LENGTH = 500_000;
const MAX_FIELD_LENGTH = 20_000;
const MAX_ANALYSIS_LENGTH = 60_000;
const UID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|rec-\d+-[0-9a-f]+)$/i;

module.exports = async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ ok: false, error: "POST only" });
  }

  const authorization = authorizeRequest(request);
  if (!authorization.ok) {
    return response.status(authorization.status).json({ ok: false, error: authorization.error });
  }

  try {
    const endpoint = getSheetsEndpoint();
    const syncSecret = getSyncSecret();
    const payload = validatePayload(parseBody(request.body));
    const serializedPayload = JSON.stringify(payload);

    if (serializedPayload.length > MAX_PAYLOAD_LENGTH) {
      throw clientError("同期データが大きすぎます。件数を減らしてください。");
    }

    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const signature = crypto
      .createHmac("sha256", syncSecret)
      .update(`${timestamp}.${nonce}.${serializedPayload}`)
      .digest("hex");
    const form = new URLSearchParams({
      payload: serializedPayload,
      timestamp,
      nonce,
      signature,
    });
    const sheetsResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: form.toString(),
      redirect: "follow",
    });

    const text = await sheetsResponse.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      return response.status(502).json({ ok: false, error: "Sheetsの応答を確認できませんでした。" });
    }

    const expectedUids = payload.records.map((record) => record.uid);
    const acceptedUids = Array.isArray(result.acceptedUids) ? result.acceptedUids.map(String) : [];
    const acceptedSet = new Set(acceptedUids);
    const allAccepted = acceptedUids.length === expectedUids.length
      && expectedUids.every((uid) => acceptedSet.has(uid));

    if (!sheetsResponse.ok || !result.ok || Number(result.count) !== expectedUids.length || !allAccepted) {
      return response.status(502).json({
        ok: false,
        error: result.error || "Sheetsへの反映内容を確認できませんでした。",
      });
    }

    return response.status(200).json({
      ok: true,
      acceptedUids,
      inserted: Number(result.inserted) || 0,
      updated: Number(result.updated) || 0,
      endpointVersion: result.version || "",
    });
  } catch (error) {
    const status = Number(error.status) || 502;
    return response.status(status).json({
      ok: false,
      error: error.publicMessage || "Sheets同期に失敗しました。",
    });
  }
};

function authorizeRequest(request) {
  const expected = String(process.env.APP_ACCESS_TOKEN || "");
  if (!expected) {
    return { ok: false, status: 503, error: "スタッフ用アクセスコードが未設定です。" };
  }
  const actual = String(request.headers?.["x-app-access-code"] || "");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  const valid = expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  return valid
    ? { ok: true }
    : { ok: false, status: 401, error: "スタッフ用アクセスコードが違います。" };
}

function getSheetsEndpoint() {
  const endpoint = String(process.env.SHEETS_WEB_APP_URL || "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint)) {
    const error = new Error("Invalid SHEETS_WEB_APP_URL");
    error.status = 503;
    error.publicMessage = "Sheets同期先がサーバーに設定されていません。";
    throw error;
  }
  return endpoint;
}

function getSyncSecret() {
  const secret = String(process.env.SHEETS_SYNC_SECRET || "");
  if (secret.length < 32) {
    const error = new Error("Missing or short SHEETS_SYNC_SECRET");
    error.status = 503;
    error.publicMessage = "Sheets同期用の署名鍵が未設定です。";
    throw error;
  }
  return secret;
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      throw clientError("同期データのJSON形式が正しくありません。");
    }
  }
  return body;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw clientError("同期データの形式が正しくありません。");
  }
  if (payload.source !== "oiso-record-app" || Number(payload.version) !== 2) {
    throw clientError("対応していない同期データです。");
  }

  const records = Array.isArray(payload.records) ? payload.records : [];
  if (!records.length || records.length > MAX_RECORDS_PER_REQUEST) {
    throw clientError(`1回の同期件数は1-${MAX_RECORDS_PER_REQUEST}件です。`);
  }

  const seenUids = new Set();
  records.forEach((record) => validateRecord(record, seenUids));
  return payload;
}

function validateRecord(record, seenUids) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw clientError("レコード形式が正しくありません。");
  }

  const uid = String(record.uid || "");
  if (!UID_PATTERN.test(uid) || seenUids.has(uid)) {
    throw clientError("レコードUIDが不正または重複しています。");
  }
  seenUids.add(uid);

  if (!record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) {
    throw clientError("レコード項目がありません。");
  }
  const fieldEntries = Object.entries(record.fields);
  if (fieldEntries.length > 60) {
    throw clientError("レコード項目数が多すぎます。");
  }
  fieldEntries.forEach(([key, value]) => {
    if (String(key).length > 100 || !isScalar(value) || String(value ?? "").length > MAX_FIELD_LENGTH) {
      throw clientError("レコード項目の値が不正または大きすぎます。");
    }
  });

  if (record.analysis !== null && record.analysis !== undefined) {
    if (typeof record.analysis !== "object" || Array.isArray(record.analysis)) {
      throw clientError("AI解析データの形式が正しくありません。");
    }
    if (JSON.stringify(record.analysis).length > MAX_ANALYSIS_LENGTH) {
      throw clientError("AI解析データが大きすぎます。");
    }
  }

  if (record.flags !== undefined) {
    if (!Array.isArray(record.flags) || record.flags.length > 50
      || record.flags.some((flag) => String(flag).length > 500)) {
      throw clientError("要確認フラグの形式が正しくありません。");
    }
  }
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function clientError(message) {
  const error = new Error(message);
  error.status = 400;
  error.publicMessage = message;
  return error;
}
