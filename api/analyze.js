const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const crypto = require("crypto");
const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_IMAGES = 3;
const MAX_IMAGE_DATA_URL_LENGTH = 1_800_000;
const MAX_TOTAL_IMAGE_LENGTH = 4_000_000;

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return response.status(503).json({
      ok: false,
      error: "OpenAI APIキーがサーバーに設定されていません。",
    });
  }

  try {
    const body = parseBody(request.body);
    const input = sanitizeInput(body.input);
    const images = validateImages(body.images);

    if (!images.length) {
      return response.status(400).json({ ok: false, error: "写真を1枚以上選択してください。" });
    }

    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
    const openAIResponse = await fetchOpenAI(apiKey, model, input, images);
    return response.status(200).json({
      ok: true,
      analysis: openAIResponse.analysis,
      usage: openAIResponse.usage,
      model,
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    return response.status(status).json({
      ok: false,
      error: error.publicMessage || "AI一次判定に失敗しました。",
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
  const keys = [
    "artist",
    "title",
    "labelName",
    "catalogNo",
    "country",
    "year",
    "format",
    "conditionGrade",
    "obiStatus",
    "labelInfo",
    "conditionMemo",
    "fieldNote",
  ];
  return Object.fromEntries(keys.map((key) => [key, cleanText(source[key], 600)]));
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function validateImages(images) {
  if (!Array.isArray(images)) return [];
  const safeImages = images.slice(0, MAX_IMAGES).map((image) => {
    const type = ["front", "back", "disc"].includes(image?.type) ? image.type : "other";
    const dataUrl = String(image?.dataUrl || "");
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(dataUrl)) {
      throw clientError("対応していない画像形式です。");
    }
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
      throw clientError("画像が大きすぎます。撮影し直してください。");
    }
    return { type, dataUrl };
  });

  const totalLength = safeImages.reduce((sum, image) => sum + image.dataUrl.length, 0);
  if (totalLength > MAX_TOTAL_IMAGE_LENGTH) {
    throw clientError("画像の合計サイズが大きすぎます。");
  }
  return safeImages;
}

function clientError(message) {
  const error = new Error(message);
  error.status = 400;
  error.publicMessage = message;
  return error;
}

async function fetchOpenAI(apiKey, model, input, images) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);

  try {
    const openAIResult = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        store: false,
        input: [{ role: "user", content: buildContent(input, images) }],
        max_output_tokens: 2200,
        text: {
          format: {
            type: "json_schema",
            name: "record_appraisal_v3",
            strict: true,
            schema: analysisJsonSchema(),
          },
        },
      }),
    });

    const data = await openAIResult.json().catch(() => ({}));
    if (!openAIResult.ok) {
      const error = new Error(data.error?.message || `OpenAI API error ${openAIResult.status}`);
      error.status = openAIResult.status === 429 ? 429 : 502;
      error.publicMessage = openAIResult.status === 429
        ? "AI利用上限に達しました。少し待ってから再実行してください。"
        : "OpenAIとの通信に失敗しました。";
      throw error;
    }

    if (data.status !== "completed") {
      const reason = data.incomplete_details?.reason || "incomplete";
      const error = new Error(reason);
      error.status = 502;
      error.publicMessage = reason === "max_output_tokens"
        ? "AIの出力が途中で切れました。もう一度実行してください。"
        : "AIが判定を完了できませんでした。";
      throw error;
    }

    const refusal = extractRefusal(data);
    if (refusal) {
      const error = new Error(refusal);
      error.status = 422;
      error.publicMessage = "この画像ではAI判定を実行できませんでした。";
      throw error;
    }

    const text = extractResponseText(data);
    if (!text) {
      const error = new Error("Missing output text");
      error.status = 502;
      error.publicMessage = "AIから判定結果を取得できませんでした。";
      throw error;
    }

    return {
      analysis: JSON.parse(text),
      usage: data.usage || null,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      error.status = 504;
      error.publicMessage = "AI判定がタイムアウトしました。";
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildContent(input, images) {
  const content = [{ type: "input_text", text: buildAnalysisPrompt(input, images) }];
  const labels = {
    front: "ジャケット表。全体、タイトル、アーティスト、帯の有無を確認する画像",
    back: "ジャケット裏。型番、バーコード、権利表記、国、年を確認する画像",
    disc: "A面センターラベル。レーベル、型番、回転数、Promo表記を確認する画像",
    other: "補足画像",
  };

  images.forEach((image, index) => {
    content.push({ type: "input_text", text: `画像${index + 1}: ${labels[image.type]}` });
    content.push({
      type: "input_image",
      image_url: image.dataUrl,
      detail: image.type === "front" ? "low" : "high",
    });
  });
  return content;
}

function buildAnalysisPrompt(input, images) {
  const availablePhotos = images.map((image) => image.type).join(", ");
  return [
    "あなたは日本の中古レコード店の一次仕分け担当です。最優先は高額盤の見逃し防止であり、価格欄を無理に埋めることではありません。",
    "",
    "判断原則:",
    "- 写真で確認できた事実と推測を分ける。読めない項目はnullにする。",
    "- Discogs検索は実行していない。Release ID、Median、販売履歴を生成しない。discogs_median_statusは必ず未取得にする。",
    "- Catalog Number、Label、Country、Formatが整合し、Release候補が1件に絞れる場合だけrelease_identifiedをtrueにする。",
    "- Release候補が複数、型番不明、手入力と画像が矛盾する場合は価格をnullにして要確認とする。",
    "- Original、Reissue、Promo、White Labelは根拠がなければ未確定とする。Promo等の可能性は価格昇格ではなく高額保留の理由にする。",
    "- 盤質は写真からEX/VG+/VGと断定しない。手動盤質がない場合、価格はVG+参考であり実物盤質未評価と明記する。",
    "- Matrix / Runoutは専用接写がない限り推測しない。",
    "- AOR、Rare Groove、City Pop等のジャンル名だけで価格帯を上げない。",
    "- 国内価格の上限が12,000円以上、識別確信度90未満、写真不足、版違いの可能性がある場合はreview_requiredをtrueにする。",
    "- DU、Face、BBQは金額を捏造せず、取扱文脈との相性を 高・中・低・不明 と理由で返す。",
    "",
    "価格区分:",
    "C: 0-1,499円 / B: 1,500-4,999円 / A: 5,000-11,999円 / S: 12,000円以上。版違い・価格差・希少仕様は要確認。",
    "価格帯と売れる速度は別々に評価する。sell_throughはfast / normal / slow / unknown。",
    "",
    "一次判定の写真基準:",
    "ジャケット表、ジャケット裏、A面センターラベルが揃うのが標準。ぼけ、反射、文字切れ、型番判読不能はphoto_qualityをinsufficientにする。",
    `受領画像: ${availablePhotos || "なし"}`,
    "",
    "手入力補足:",
    `Artist: ${input.artist || ""}`,
    `Title: ${input.title || ""}`,
    `Label: ${input.labelName || ""}`,
    `Catalog Number: ${input.catalogNo || ""}`,
    `Country: ${input.country || ""}`,
    `Year: ${input.year || ""}`,
    `Format: ${input.format || ""}`,
    `人が確認した盤質: ${input.conditionGrade || "未評価"}`,
    `帯: ${input.obiStatus || "未確認"}`,
    `盤種・ラベル情報: ${input.labelInfo || ""}`,
    `状態メモ: ${input.conditionMemo || ""}`,
    `現場所見: ${input.fieldNote || ""}`,
    "",
    "日本語で、指定JSON Schemaだけを返してください。",
  ].join("\n");
}

function analysisJsonSchema() {
  const nullableString = { type: ["string", "null"] };
  const nullableInteger = { type: ["integer", "null"], minimum: 0 };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "artist", "title", "label", "catalog_number", "country", "year", "format",
      "genre_style", "matrix_runout", "pressing", "discogs_search_keywords",
      "discogs_release_candidates", "discogs_median_status", "release_identified",
      "identification_confidence", "price_confidence", "photo_quality", "observed_facts",
      "inferred_facts", "domestic_demand_evaluation", "sell_through",
      "domestic_price_low_jpy", "domestic_price_high_jpy", "condition_basis",
      "du_evaluation", "face_records_evaluation", "bbq_records_evaluation",
      "popup_sales_category", "domestic_position", "price_reasoning", "comment",
      "review_required", "review_reasons", "next_check_points"
    ],
    properties: {
      artist: nullableString,
      title: nullableString,
      label: nullableString,
      catalog_number: nullableString,
      country: nullableString,
      year: nullableString,
      format: nullableString,
      genre_style: nullableString,
      matrix_runout: nullableString,
      pressing: nullableString,
      discogs_search_keywords: nullableString,
      discogs_release_candidates: { type: "array", items: { type: "string" }, maxItems: 3 },
      discogs_median_status: { type: "string", enum: ["未取得", "要照合"] },
      release_identified: { type: "boolean" },
      identification_confidence: { type: "integer", minimum: 0, maximum: 100 },
      price_confidence: { type: "integer", minimum: 0, maximum: 100 },
      photo_quality: { type: "string", enum: ["good", "usable", "insufficient"] },
      observed_facts: { type: "array", items: { type: "string" }, maxItems: 8 },
      inferred_facts: { type: "array", items: { type: "string" }, maxItems: 6 },
      domestic_demand_evaluation: nullableString,
      sell_through: { type: "string", enum: ["fast", "normal", "slow", "unknown"] },
      domestic_price_low_jpy: nullableInteger,
      domestic_price_high_jpy: nullableInteger,
      condition_basis: nullableString,
      du_evaluation: nullableString,
      face_records_evaluation: nullableString,
      bbq_records_evaluation: nullableString,
      popup_sales_category: {
        type: "string",
        enum: ["即売向き", "POPUP向き", "高額保留", "業者流し向き", "要確認"]
      },
      domestic_position: nullableString,
      price_reasoning: nullableString,
      comment: nullableString,
      review_required: { type: "boolean" },
      review_reasons: { type: "array", items: { type: "string" }, maxItems: 8 },
      next_check_points: { type: "array", items: { type: "string" }, maxItems: 8 }
    }
  };
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;
  const parts = [];
  (data.output || []).forEach((item) => {
    (item.content || []).forEach((content) => {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "text" && content.text) parts.push(content.text);
    });
  });
  return parts.join("\n").trim();
}

function extractRefusal(data) {
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "refusal") return content.refusal || "refused";
    }
  }
  return "";
}
