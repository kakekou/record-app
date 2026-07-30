const crypto = require("crypto");

const DISCOGS_SEARCH_URL = "https://api.discogs.com/database/search";
const DEFAULT_USER_AGENT = "OisoRecordApp/1.0 +https://record-app-ten.vercel.app/";
const MAX_CANDIDATES = 8;

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

  const token = String(process.env.DISCOGS_TOKEN || "").trim();
  if (!token) {
    return response.status(503).json({
      ok: false,
      error: "Discogs APIトークンがサーバーに設定されていません。",
    });
  }

  try {
    const body = parseBody(request.body);
    const input = sanitizeInput(body.input);
    if (![input.catalogNo, input.artist, input.title].some(Boolean)) {
      return response.status(400).json({
        ok: false,
        error: "型番、アーティスト、タイトルのいずれかが必要です。",
      });
    }

    const data = await fetchDiscogs(token, input);
    const candidates = (Array.isArray(data.results) ? data.results : [])
      .map(toCandidate)
      .filter((candidate) => candidate.id && candidate.url)
      .sort((left, right) => candidateScore(right, input) - candidateScore(left, input))
      .slice(0, MAX_CANDIDATES);

    return response.status(200).json({
      ok: true,
      candidates,
      marketDataIncluded: false,
      source: "Discogs API metadata",
    });
  } catch (error) {
    const status = Number(error.status) || 502;
    return response.status(status).json({
      ok: false,
      error: error.publicMessage || "Discogs候補を取得できませんでした。",
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

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") return JSON.parse(body);
  return body;
}

function sanitizeInput(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    catalogNo: cleanText(source.catalogNo, 120),
    artist: cleanText(source.artist, 200),
    title: cleanText(source.title, 200),
    country: cleanText(source.country, 80),
    year: cleanYear(source.year),
    format: cleanText(source.format, 80),
  };
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanYear(value) {
  const year = String(value || "").trim();
  return /^\d{4}$/.test(year) ? year : "";
}

async function fetchDiscogs(token, input) {
  const params = new URLSearchParams({
    type: "release",
    per_page: String(MAX_CANDIDATES),
    page: "1",
  });
  if (input.catalogNo) params.set("catno", input.catalogNo);
  if (input.artist) params.set("artist", input.artist);
  if (input.title) params.set("release_title", input.title);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let apiResponse;
  try {
    apiResponse = await fetch(`${DISCOGS_SEARCH_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/vnd.discogs.v2.discogs+json",
        Authorization: `Discogs token=${token}`,
        "User-Agent": process.env.DISCOGS_USER_AGENT || DEFAULT_USER_AGENT,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const error = new Error("Discogs API request failed");
    error.status = apiResponse.status === 429 ? 429 : 502;
    error.publicMessage = apiResponse.status === 429
      ? "Discogsの利用上限に達しました。少し待ってから再実行してください。"
      : (data.message || "Discogs候補を取得できませんでした。");
    throw error;
  }
  return data;
}

function toCandidate(result) {
  const uri = cleanText(result?.uri, 500);
  return {
    id: Number.isInteger(result?.id) ? result.id : Number(result?.id) || null,
    title: cleanText(result?.title, 300),
    year: cleanText(result?.year, 20),
    country: cleanText(result?.country, 80),
    format: cleanList(result?.format),
    label: cleanList(result?.label),
    catno: cleanText(result?.catno, 120),
    url: uri.startsWith("http")
      ? uri
      : (uri.startsWith("/") ? `https://www.discogs.com${uri}` : ""),
  };
}

function cleanList(value) {
  if (!Array.isArray(value)) return cleanText(value, 300);
  return value.map((item) => cleanText(item, 100)).filter(Boolean).slice(0, 5).join(", ");
}

function candidateScore(candidate, input) {
  let score = 0;
  if (sameText(candidate.catno, input.catalogNo)) score += 100;
  if (includesText(candidate.title, input.artist)) score += 20;
  if (includesText(candidate.title, input.title)) score += 20;
  if (sameText(candidate.country, input.country)) score += 5;
  if (String(candidate.year) === String(input.year) && input.year) score += 5;
  if (includesText(candidate.format, input.format)) score += 3;
  return score;
}

function sameText(left, right) {
  const normalizedRight = normalizeText(right);
  return Boolean(normalizedRight) && normalizeText(left) === normalizedRight;
}

function includesText(left, right) {
  const normalizedRight = normalizeText(right);
  return Boolean(normalizedRight) && normalizeText(left).includes(normalizedRight);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9一-龠ぁ-んァ-ヶ]/g, "");
}

module.exports._private = {
  sanitizeInput,
  toCandidate,
  candidateScore,
};
