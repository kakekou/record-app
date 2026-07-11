const DEFAULT_SHEETS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxBSSPa1AtE95mrH4KTgld4J2DxyhHCRz8mjrmZibTFVOPH7VvijP59slL7XKm7SUs5/exec";
const crypto = require("crypto");
const MAX_RECORDS_PER_REQUEST = 50;

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
    const payload = parseBody(request.body);
    const records = Array.isArray(payload.records) ? payload.records : [];
    if (!records.length || records.length > MAX_RECORDS_PER_REQUEST) {
      return response.status(400).json({
        ok: false,
        error: `1回の同期件数は1-${MAX_RECORDS_PER_REQUEST}件です。`,
      });
    }

    const endpoint = process.env.SHEETS_WEB_APP_URL || DEFAULT_SHEETS_WEB_APP_URL;
    const form = new URLSearchParams({ payload: JSON.stringify(payload) });
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

    if (!sheetsResponse.ok || !result.ok || Number(result.count) !== records.length) {
      return response.status(502).json({
        ok: false,
        error: result.error || "Sheetsへの反映件数が一致しませんでした。",
      });
    }

    return response.status(200).json({
      ok: true,
      acceptedUids: records.map((record) => record.uid).filter(Boolean),
      inserted: Number(result.inserted) || 0,
      updated: Number(result.updated) || 0,
    });
  } catch {
    return response.status(502).json({ ok: false, error: "Sheets同期に失敗しました。" });
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

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") return JSON.parse(body);
  return body;
}
