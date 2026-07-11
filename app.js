const MASTER_COLUMNS = [
  "ID",
  "区分",
  "アーティスト",
  "タイトル",
  "型番",
  "国",
  "盤種・ラベル情報",
  "状態メモ",
  "Discogs Median USD",
  "ディスクユニオン査定額",
  "Face Records想定売価",
  "ユーザー向け販売価格",
  "価格判断",
  "販売導線",
  "ステータス",
  "文脈タグ",
  "棚設計5本タグ",
  "シリーズ束",
  "服部さん選盤候補",
  "記録媒体章立て候補",
  "山田コメント",
  "販売キャプション",
];

const FIELD_GROUPS = [
  { name: "コア識別", columns: ["ID", "区分", "アーティスト", "タイトル", "型番"] },
  { name: "盤情報", columns: ["国", "盤種・ラベル情報", "状態メモ"] },
  {
    name: "価格レイヤー",
    columns: [
      "Discogs Median USD",
      "ディスクユニオン査定額",
      "Face Records想定売価",
      "ユーザー向け販売価格",
    ],
  },
  { name: "判断レイヤー", columns: ["価格判断", "販売導線", "ステータス"] },
  {
    name: "編集レイヤー",
    columns: [
      "文脈タグ",
      "棚設計5本タグ",
      "シリーズ束",
      "服部さん選盤候補",
      "記録媒体章立て候補",
    ],
  },
  { name: "記述レイヤー", columns: ["山田コメント", "販売キャプション"] },
];

const PRICE_OPTIONS = [
  "要確認",
  "S｜高額・個別管理",
  "A｜中高額良盤",
  "B｜回転良盤",
  "C｜入口商品",
];

const STATUS_OPTIONS = ["要照合", "販売準備中", "文脈化保留", "個別管理"];

const SHELF_TAGS = [
  "Jacket Graffiti",
  "Night Window",
  "Cheap but Classic",
  "和帯の余白",
  "Sleeper's Choice",
];

const STORAGE_KEY = "oiso-record-app.records.v1";
const SETTINGS_KEY = "oiso-record-app.settings.v1";
const DEFAULT_SYNC_URL = "https://script.google.com/macros/s/AKfycbxBSSPa1AtE95mrH4KTgld4J2DxyhHCRz8mjrmZibTFVOPH7VvijP59slL7XKm7SUs5/exec";
const OPENAI_PROXY_URL = "/api/analyze";
const SHEETS_PROXY_URL = "/api/sync";
const AI_APPRAISAL_SCHEMA_VERSION = "record-appraisal-v3";
const ACCESS_TOKEN_SESSION_KEY = "oiso-record-app.access-token";
const DB_NAME = "oiso-record-app";
const DB_STORE = "photos";

let records = [];
let settings = {};
let selectedRecordId = null;
let activeView = "capture";
let currentFiles = {};
let toastTimer = null;
let photoUrlCache = new Map();
let recordStorageWritable = true;
let recordStorageError = "";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

document.addEventListener("DOMContentLoaded", () => {
  records = loadRecords();
  settings = loadSettings();
  enforceFixedSyncUrl();
  seedDate();
  fillOptionLists();
  fillSettings();
  bindEvents();
  renderAll();
  registerServiceWorker();
  if (recordStorageError) showToast(recordStorageError);
});

function bindEvents() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  $("#intake-form").addEventListener("submit", handleIntakeSubmit);
  $("#reset-form").addEventListener("click", resetIntakeForm);
  $("#analyze-openai").addEventListener("click", analyzeWithOpenAI);

  $$("[data-photo]").forEach((input) => {
    input.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) setCurrentPhoto(event.target.dataset.photo, file);
    });
  });

  $("#approve-record").addEventListener("click", approveSelectedRecord);
  $("#delete-record").addEventListener("click", deleteSelectedRecord);

  $("#export-csv").addEventListener("click", exportCsv);
  $("#export-json").addEventListener("click", exportJson);
  $("#sync-sheets").addEventListener("click", syncApprovedRecords);
  $("#sync-sheets-secondary").addEventListener("click", syncApprovedRecords);
  $("#save-sync-url").addEventListener("click", saveSyncSettings);
  $("#copy-share-link").addEventListener("click", copyConfiguredShareLink);
  $("#create-test-record").addEventListener("click", createTestApprovedRecord);
  $("#reset-sync-state").addEventListener("click", resetSyncState);
  $("#clear-all").addEventListener("click", clearAllData);

  ["#search-records", "#filter-price", "#filter-status", "#filter-shelf"].forEach((selector) => {
    $(selector).addEventListener("input", renderMaster);
    $(selector).addEventListener("change", renderMaster);
  });
}

function fillSettings() {
  $("#sync-url").value = settings.syncUrl || DEFAULT_SYNC_URL;
  $("#sync-url").readOnly = true;
}

function enforceFixedSyncUrl() {
  settings.syncUrl = DEFAULT_SYNC_URL;
  saveSettings();

  const params = new URLSearchParams(location.search);
  if (!params.has("syncUrl")) return;

  params.delete("syncUrl");
  const cleanUrl = `${location.pathname}${params.toString() ? `?${params.toString()}` : ""}${location.hash}`;
  history.replaceState(null, "", cleanUrl);
}

function isAppsScriptExecUrl(value) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/.test(String(value || "").trim());
}

function seedDate() {
  const today = new Date();
  $("#shot-date").value = today.toISOString().slice(0, 10);
}

function fillOptionLists() {
  const shelfDatalist = $("#shelf-options");
  shelfDatalist.innerHTML = SHELF_TAGS.map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join("");

  fillSelect("#filter-price", PRICE_OPTIONS.filter((value) => value !== "要確認"));
  fillSelect("#filter-status", STATUS_OPTIONS);
  fillSelect("#filter-shelf", SHELF_TAGS);
}

function fillSelect(selector, values) {
  const select = $(selector);
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function setView(view) {
  activeView = view;
  $$(".tab").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("is-active", section.id === `view-${view}`));
  renderAll();
}

async function handleIntakeSubmit(event) {
  event.preventDefault();
  const formData = getIntakeData();
  const record = createDraftRecord(formData);
  await attachPhotos(record);
  records.push(record);
  selectedRecordId = record.uid;
  saveRecords();
  resetIntakeForm();
  renderAll();
  setView("review");
  showToast("下書きを作成しました。");
}

function getIntakeData() {
  const data = Object.fromEntries(new FormData($("#intake-form")).entries());
  Object.keys(data).forEach((key) => {
    if (typeof data[key] === "string") data[key] = data[key].trim();
  });
  return data;
}

function createDraftRecord(input) {
  const uid = makeUid();
  const now = new Date().toISOString();
  const shelf = inferShelf(input);
  const contextTags = inferContextTags(input);
  const country = input.country || inferCountry(input);
  const fields = emptyFields();

  fields["ID"] = nextId();
  fields["区分"] = "新規入力";
  fields["アーティスト"] = input.artist || "";
  fields["タイトル"] = input.title || "";
  fields["型番"] = input.catalogNo || "";
  fields["国"] = country || "";
  fields["盤種・ラベル情報"] = buildLabelInfo(input);
  fields["状態メモ"] = compactText([
    input.conditionGrade && `盤質: ${input.conditionGrade}`,
    input.conditionMemo,
  ], " / ");
  fields["価格判断"] = "要確認";
  fields["販売導線"] = "未判断";
  fields["ステータス"] = inferStatus(input);
  fields["文脈タグ"] = contextTags;
  fields["棚設計5本タグ"] = shelf;
  fields["山田コメント"] = input.fieldNote || "";
  fields["販売キャプション"] = buildCaptionDraft(input);

  const duplicate = findDuplicateCandidate(input);
  const flags = uniqueFlags([
    !input.catalogNo && "型番",
    !country && "国",
    !input.format && "盤種",
    !input.conditionGrade && "盤質未評価",
    duplicate && `重複候補 ID ${duplicate.fields.ID}`,
    "Discogs Median USD",
    "価格判断",
    "販売導線",
    "販売キャプション",
  ]);

  return {
    uid,
    createdAt: now,
    updatedAt: now,
    workflowState: "draft",
    input,
    fields,
    flags,
    photos: {},
  };
}

function buildLabelInfo(input) {
  return [
    input.labelName && `Label: ${input.labelName}`,
    input.year && `Year: ${input.year}`,
    input.format && `Format: ${input.format}`,
    input.obiStatus,
    input.labelInfo,
  ].filter(Boolean).join(" / ");
}

function findDuplicateCandidate(input) {
  const catalog = normalizeMatchText(input.catalogNo);
  if (!catalog) return null;
  const artist = normalizeMatchText(input.artist);
  const title = normalizeMatchText(input.title);
  return records.find((record) => {
    if (normalizeMatchText(record.fields?.["型番"]) !== catalog) return false;
    const sameArtist = !artist || normalizeMatchText(record.fields?.["アーティスト"]) === artist;
    const sameTitle = !title || normalizeMatchText(record.fields?.["タイトル"]) === title;
    return sameArtist && sameTitle;
  }) || null;
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9一-龠ぁ-んァ-ヶ]/g, "");
}

function emptyFields() {
  return MASTER_COLUMNS.reduce((acc, column) => {
    acc[column] = "";
    return acc;
  }, {});
}

function uniqueFlags(flags) {
  return Array.from(new Set(flags.filter(Boolean)));
}

function inferCountry(input) {
  const haystack = `${input.labelInfo || ""} ${input.conditionMemo || ""}`.toLowerCase();
  if (/japan|日本|国内|帯|見本盤/.test(haystack)) return "Japan";
  if (/\bus\b|u\.s\.|usa|米国/.test(haystack)) return "US";
  if (/\buk\b|england|英国/.test(haystack)) return "UK";
  if (/canada|カナダ/.test(haystack)) return "Canada";
  if (/netherlands|holland|オランダ/.test(haystack)) return "Netherlands";
  return "";
}

function inferStatus(input) {
  const haystack = `${input.labelInfo || ""} ${input.conditionMemo || ""} ${input.fieldNote || ""}`;
  if (/高額|個別|promo|プロモ|white label|白ラベル/i.test(haystack)) return "要照合";
  return "要照合";
}

function inferShelf(input) {
  const haystack = `${input.artist || ""} ${input.title || ""} ${input.labelInfo || ""} ${input.fieldNote || ""}`.toLowerCase();
  const shelves = [];
  if (/帯|japan|日本|国内|見本盤/.test(haystack)) shelves.push("和帯の余白");
  if (/ambient|balearic|aor|city|night|dub|window|夜|都市|メロウ/.test(haystack)) shelves.push("Night Window");
  if (/cheap|classic|定番|入口|回転/.test(haystack)) shelves.push("Cheap but Classic");
  if (/jacket|cover|graffiti|色|ジャケ|視覚/.test(haystack)) shelves.push("Jacket Graffiti");
  if (!shelves.length) shelves.push("Sleeper's Choice");
  return shelves.slice(0, 2).join("｜");
}

function inferContextTags(input) {
  const haystack = `${input.artist || ""} ${input.title || ""} ${input.labelInfo || ""} ${input.fieldNote || ""}`;
  const rules = [
    [/promo|プロモ|白ラベル|見本盤/i, "Promo"],
    [/jazz|ジャズ/i, "Jazz"],
    [/funk|ファンク/i, "Funk"],
    [/soul|ソウル/i, "Soul"],
    [/aor/i, "AOR"],
    [/ambient|アンビエント/i, "Ambient"],
    [/city pop|シティポップ/i, "City Pop"],
    [/rare groove|レアグルーヴ/i, "Rare Groove"],
    [/sampling|サンプリング|break|ブレイク/i, "Sampling"],
  ];
  const tags = rules.filter(([regex]) => regex.test(haystack)).map(([, tag]) => tag);
  return tags.slice(0, 4).join(" / ");
}

function buildCaptionDraft(input) {
  const artistTitle = [input.artist, input.title].filter(Boolean).join(" - ");
  if (!artistTitle) return "";
  const detail = input.labelInfo ? ` ${input.labelInfo}。` : "。";
  return `${artistTitle}${detail}[要確認]`;
}

async function analyzeWithOpenAI() {
  const input = getIntakeData();
  const files = Object.entries(currentFiles).filter(([, file]) => file);

  if (!files.length) {
    setAiStatus("写真を1枚以上選択してください。", "error");
    return;
  }

  setAiStatus("画像を圧縮しています...", "running");
  $("#analyze-openai").disabled = true;

  try {
    const images = [];
    for (const [type, file] of files) {
      images.push({ type, dataUrl: await fileToResizedDataUrl(file) });
    }

    setAiStatus("AIで一次判定中...", "running");
    const result = await requestOpenAIAnalysis(input, images);
    const analysis = {
      ...result.analysis,
      api_usage: result.usage || null,
      model: result.model || "",
    };
    const record = createDraftRecord(input);
    applyAnalysisToRecord(record, analysis);
    await attachPhotos(record);
    records.push(record);
    selectedRecordId = record.uid;
    saveRecords();
    resetIntakeForm();
    renderAll();
    setView("review");
    setAiStatus("AI一次判定から下書きを作成しました。", "success");
    showToast("AI一次判定から下書きを作成しました。");
  } catch (error) {
    setAiStatus(`査定に失敗しました: ${error.message}`, "error");
  } finally {
    $("#analyze-openai").disabled = false;
  }
}

async function requestOpenAIAnalysis(input, images) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 100000);
  const accessCode = getStaffAccessCode();
  const response = await fetch(OPENAI_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Access-Code": accessCode,
    },
    signal: controller.signal,
    body: JSON.stringify({ input, images }),
  });
  try {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.analysis) {
      if (response.status === 401) sessionStorage.removeItem(ACCESS_TOKEN_SESSION_KEY);
      if (response.status === 404 && ["127.0.0.1", "localhost"].includes(location.hostname)) {
        throw new Error("AI判定はVercel公開URLで実行してください。");
      }
      throw new Error(data.error || `AI API error ${response.status}`);
    }
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

function getStaffAccessCode() {
  const saved = sessionStorage.getItem(ACCESS_TOKEN_SESSION_KEY) || "";
  if (saved) return saved;
  const entered = String(prompt("スタッフ用アクセスコードを入力してください。") || "").trim();
  if (!entered) throw new Error("スタッフ用アクセスコードが必要です。");
  sessionStorage.setItem(ACCESS_TOKEN_SESSION_KEY, entered);
  return entered;
}

function compactText(items, separator) {
  return items.map((item) => String(item || "").trim()).filter(Boolean).join(separator);
}

function setAiStatus(message, state) {
  const status = $("#ai-status");
  status.textContent = message;
  status.dataset.state = state || "";
}

function appColumn(index) {
  return MASTER_COLUMNS[index];
}

function normalizeAnalysis(analysis) {
  const source = analysis || {};
  const lowPrice = finiteInteger(source.domestic_price_low_jpy);
  const highPrice = finiteInteger(source.domestic_price_high_jpy);
  return {
    artist: source.artist || "",
    title: source.title || "",
    label: source.label || "",
    catalog_number: source.catalog_number || "",
    country: source.country || "",
    year: source.year || "",
    format: source.format || "",
    genre_style: source.genre_style || "",
    matrix_runout: source.matrix_runout || "",
    pressing: source.pressing || "",
    discogs_search_keywords: source.discogs_search_keywords || "",
    discogs_release_candidates: Array.isArray(source.discogs_release_candidates)
      ? source.discogs_release_candidates
      : [],
    discogs_median_status: source.discogs_median_status || "未取得",
    release_identified: Boolean(source.release_identified),
    identification_confidence: confidenceNumber(source.identification_confidence),
    price_confidence: confidenceNumber(source.price_confidence),
    photo_quality: source.photo_quality || "insufficient",
    observed_facts: stringArray(source.observed_facts),
    inferred_facts: stringArray(source.inferred_facts),
    domestic_demand_evaluation: source.domestic_demand_evaluation || source.domestic_position || "",
    sell_through: source.sell_through || "unknown",
    domestic_price_low_jpy: lowPrice,
    domestic_price_high_jpy: highPrice,
    domestic_price_range_jpy: formatPriceRange(lowPrice, highPrice),
    condition_basis: source.condition_basis || "",
    du_evaluation: source.du_evaluation || "",
    face_records_evaluation: source.face_records_evaluation || "",
    bbq_records_evaluation: source.bbq_records_evaluation || "",
    popup_sales_category: source.popup_sales_category || source.sales_category || "",
    domestic_position: source.domestic_position || "",
    price_reasoning: source.price_reasoning || "",
    comment: source.comment || source.short_comment || "",
    review_required: Boolean(source.review_required),
    review_reasons: stringArray(source.review_reasons || source.uncertainty_flags),
    next_check_points: stringArray(source.next_check_points),
    api_usage: source.api_usage || null,
    model: source.model || "",
  };
}

function finiteInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function confidenceNumber(value) {
  const number = finiteInteger(value);
  return number === null ? 0 : Math.min(100, number);
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(/[\n｜]+/).map((item) => item.trim()).filter(Boolean);
}

function formatPriceRange(low, high) {
  if (low === null || high === null || high < low) return "";
  return `${low.toLocaleString("ja-JP")}-${high.toLocaleString("ja-JP")}円`;
}

function fillFieldWhenBlank(fields, column, value) {
  if (!String(fields[column] || "").trim() && value) fields[column] = value;
}

function collectInputConflicts(input, analysis) {
  const pairs = [
    ["Artist", input.artist, analysis.artist],
    ["Title", input.title, analysis.title],
    ["型番", input.catalogNo, analysis.catalog_number],
    ["国", input.country, analysis.country],
    ["盤種", input.format, analysis.format],
  ];
  return pairs
    .filter(([, manual, suggested]) => manual && suggested && normalizeMatchText(manual) !== normalizeMatchText(suggested))
    .map(([label]) => `手入力とAI不一致: ${label}`);
}

function requiresHumanReview(analysis, conflicts) {
  const lowBand = priceBand(analysis.domestic_price_low_jpy);
  const highBand = priceBand(analysis.domestic_price_high_jpy);
  return Boolean(
    analysis.review_required
    || conflicts.length
    || !analysis.release_identified
    || analysis.discogs_release_candidates.length !== 1
    || analysis.identification_confidence < 90
    || analysis.price_confidence < 70
    || analysis.photo_quality !== "good"
    || analysis.domestic_price_high_jpy === null
    || analysis.domestic_price_high_jpy >= 12000
    || (lowBand && highBand && lowBand !== highBand)
    || /promo|white label|test pressing|プロモ|白ラベル|見本盤/i.test(analysis.pressing)
  );
}

function priceBand(price) {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return "";
  if (Number(price) >= 12000) return "S";
  if (Number(price) >= 5000) return "A";
  if (Number(price) >= 1500) return "B";
  return "C";
}

function applyAnalysisToRecord(record, rawAnalysis) {
  const analysis = normalizeAnalysis(rawAnalysis);
  const fields = record.fields;
  const conflicts = collectInputConflicts(record.input || {}, analysis);
  const reviewRequired = requiresHumanReview(analysis, conflicts);
  analysis.review_required = reviewRequired;

  fillFieldWhenBlank(fields, appColumn(2), analysis.artist);
  fillFieldWhenBlank(fields, appColumn(3), analysis.title);
  fillFieldWhenBlank(fields, appColumn(4), analysis.catalog_number);
  fillFieldWhenBlank(fields, appColumn(5), analysis.country);

  fields[appColumn(6)] = compactText([
    analysis.label && `Label: ${analysis.label}`,
    analysis.year && `Year: ${analysis.year}`,
    analysis.format,
    analysis.pressing,
    analysis.genre_style,
    analysis.matrix_runout && `Matrix: ${analysis.matrix_runout}`,
    analysis.discogs_search_keywords && `Discogs検索: ${analysis.discogs_search_keywords}`,
    analysis.discogs_release_candidates.length && `Release候補: ${analysis.discogs_release_candidates.join(" / ")}`,
    fields[appColumn(6)],
  ], " / ");

  fields[appColumn(8)] = "未取得（Discogs未接続）";
  fields[appColumn(9)] = analysis.du_evaluation ? `AI参考: ${analysis.du_evaluation}` : "AI参考: 不明";
  fields[appColumn(10)] = analysis.face_records_evaluation ? `AI参考: ${analysis.face_records_evaluation}` : "AI参考: 不明";
  fields[appColumn(11)] = analysis.release_identified ? analysis.domestic_price_range_jpy : "";
  fields[appColumn(12)] = priceRankFromAnalysis(analysis);
  fields[appColumn(13)] = reviewRequired
    ? (analysis.domestic_price_high_jpy >= 12000 ? "高額保留" : "要確認")
    : (analysis.popup_sales_category || fields[appColumn(13)]);
  fields[appColumn(14)] = statusFromAnalysis(fields[appColumn(12)], analysis);
  fields[appColumn(15)] = compactText([
    analysis.genre_style,
    analysis.domestic_demand_evaluation,
    analysis.domestic_position,
  ], " / ");
  fields[appColumn(16)] = shelfFromAnalysis(analysis) || fields[appColumn(16)];
  fields[appColumn(20)] = buildAppraisalComment(analysis);
  fields[appColumn(21)] = buildAnalysisCaption(analysis);

  record.analysis = {
    ...analysis,
    review_required: reviewRequired,
    input_conflicts: conflicts,
    schemaVersion: AI_APPRAISAL_SCHEMA_VERSION,
  };
  const retainedFlags = (record.flags || []).filter((flag) => {
    if (["Discogs Median USD", "価格判断", "販売導線", "販売キャプション"].includes(flag)) return false;
    if (flag === "型番" && fields[appColumn(4)]) return false;
    if (flag === "国" && fields[appColumn(5)]) return false;
    if (flag === "盤種" && analysis.format) return false;
    return true;
  });
  record.flags = uniqueFlags([
    ...retainedFlags,
    ...analysisFlags(analysis),
    ...conflicts,
    "Discogs未取得",
    "DU/Face/BBQ参考評価",
    !analysis.release_identified && "盤特定要確認",
    !analysis.domestic_price_range_jpy && "国内販売価格未算出",
    !analysis.catalog_number && "型番",
  ]);
  record.updatedAt = new Date().toISOString();
}

function analysisFlags(analysis) {
  return uniqueFlags([
    ...analysis.review_reasons,
    ...analysis.next_check_points,
    analysis.identification_confidence < 90 && `識別確信度 ${analysis.identification_confidence}%`,
    analysis.price_confidence < 70 && `価格確信度 ${analysis.price_confidence}%`,
    analysis.photo_quality === "insufficient" && "写真再撮影",
    analysis.photo_quality === "usable" && "写真品質要確認",
  ]).slice(0, 10);
}

function priceRankFromAnalysis(rawAnalysis) {
  const analysis = normalizeAnalysis(rawAnalysis);
  const low = analysis.domestic_price_low_jpy;
  const high = analysis.domestic_price_high_jpy;
  if (!analysis.release_identified || low === null || high === null || high < low) {
    return optionByContains(PRICE_OPTIONS, "要確認", "要確認");
  }

  const lowBand = priceBand(low);
  const highBand = priceBand(high);
  if (lowBand !== highBand) return optionByContains(PRICE_OPTIONS, "要確認", "要確認");
  return optionByPrefix(PRICE_OPTIONS, highBand, `${highBand}｜要確認`);
}

function statusFromAnalysis(priceRank, rawAnalysis) {
  const analysis = normalizeAnalysis(rawAnalysis);
  if (requiresHumanReview(analysis, []) || String(priceRank || "").includes("要確認")) {
    return optionByContains(STATUS_OPTIONS, "要照合", "要照合");
  }
  if (String(priceRank || "").startsWith("S") || analysis.popup_sales_category === "高額保留") {
    return optionByContains(STATUS_OPTIONS, "個別", "個別管理");
  }
  return optionByContains(STATUS_OPTIONS, "販売準備", "販売準備中");
}

function shelfFromAnalysis(rawAnalysis) {
  const analysis = normalizeAnalysis(rawAnalysis);
  const text = compactText([
    analysis.genre_style,
    analysis.domestic_demand_evaluation,
    analysis.domestic_position,
    analysis.comment,
  ], " ").toLowerCase();
  const shelves = [];

  if (/帯|国内盤|japanese|city pop|和モノ/.test(text)) shelves.push(SHELF_TAGS[3]);
  if (/ambient|balearic|aor|mellow|city|dub|night|free soul/.test(text)) shelves.push(SHELF_TAGS[1]);
  if (/即売|popup|classic|定番|回転|rare groove|sampling|hiphop/.test(text)) shelves.push(SHELF_TAGS[2]);
  if (/jacket|cover|アート|ジャケ|デザイン/.test(text)) shelves.push(SHELF_TAGS[0]);
  if (!shelves.length) shelves.push(SHELF_TAGS[4]);

  return uniqueFlags(shelves).filter(Boolean).slice(0, 2).join("・");
}

function buildAppraisalComment(rawAnalysis) {
  const analysis = normalizeAnalysis(rawAnalysis);
  return compactText([
    analysis.comment,
    `AI識別確信度: ${analysis.identification_confidence}% / 価格確信度: ${analysis.price_confidence}% / 写真: ${analysis.photo_quality}`,
    analysis.condition_basis && `価格の状態基準: ${analysis.condition_basis}`,
    analysis.sell_through && `売れる速度: ${analysis.sell_through}`,
    analysis.observed_facts.length && `写真で確認: ${analysis.observed_facts.join(" / ")}`,
    analysis.inferred_facts.length && `推測: ${analysis.inferred_facts.join(" / ")}`,
    analysis.price_reasoning && `価格理由: ${analysis.price_reasoning}`,
    analysis.du_evaluation && `DU: ${analysis.du_evaluation}`,
    analysis.face_records_evaluation && `Face: ${analysis.face_records_evaluation}`,
    analysis.bbq_records_evaluation && `BBQ: ${analysis.bbq_records_evaluation}`,
    analysis.review_reasons.length && `要確認理由: ${analysis.review_reasons.join(" / ")}`,
    analysis.next_check_points.length && `次確認: ${analysis.next_check_points.join(" / ")}`,
  ], "\n");
}

function buildAnalysisCaption(rawAnalysis) {
  const analysis = normalizeAnalysis(rawAnalysis);
  const title = compactText([analysis.artist, analysis.title], " - ");
  const context = compactText([
    analysis.genre_style,
    analysis.domestic_demand_evaluation,
    analysis.domestic_price_range_jpy,
    analysis.popup_sales_category,
  ], " / ");
  return compactText([title, context, analysis.comment], "。");
}

function optionByPrefix(options, prefix, fallback) {
  return options.find((option) => String(option).startsWith(prefix)) || fallback;
}

function optionByContains(options, keyword, fallback) {
  return options.find((option) => String(option).includes(keyword)) || fallback;
}

function arrayToText(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(" / ") : "";
}

function fileToResizedDataUrl(file, maxSide = 1200, quality = 0.76) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(reader.result);
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setCurrentPhoto(type, file) {
  currentFiles[type] = file;
  const url = URL.createObjectURL(file);
  $(`#preview-${type}`).style.backgroundImage = `url("${url}")`;
  $(`#name-${type}`).textContent = file.name;
}

async function attachPhotos(record) {
  const entries = Object.entries(currentFiles);
  for (const [type, file] of entries) {
    const key = `${record.uid}:${type}`;
    record.photos[type] = {
      key,
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    };
    try {
      await putPhoto(key, file);
    } catch {
      record.photos[type].storageError = true;
    }
  }
}

function resetIntakeForm() {
  $("#intake-form").reset();
  currentFiles = {};
  ["front", "back", "disc"].forEach((type) => {
    $(`#preview-${type}`).style.backgroundImage = "";
    $(`#name-${type}`).textContent = "未選択";
  });
  seedDate();
}

function renderAll() {
  renderMetrics();
  renderReview();
  renderMaster();
  renderOperations();
}

function renderMetrics() {
  const drafts = records.filter((record) => record.workflowState !== "approved").length;
  const approved = records.filter((record) => record.workflowState === "approved").length;
  const flags = records.reduce((sum, record) => sum + record.flags.length, 0);
  const unsynced = getUnsyncedApprovedRecords().length;
  $("#metric-total").textContent = records.length;
  $("#metric-drafts").textContent = drafts;
  $("#metric-approved").textContent = approved;
  $("#metric-flags").textContent = flags;
  $("#sync-count").textContent = `未同期 ${unsynced}`;
}

function renderReview() {
  const drafts = records.filter((record) => record.workflowState !== "approved");
  $("#draft-count").textContent = drafts.length;
  const list = $("#draft-list");
  list.innerHTML = "";

  drafts.forEach((record) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `record-item${record.uid === selectedRecordId ? " is-active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(record.fields["アーティスト"] || "Unknown")} / ${escapeHtml(record.fields["タイトル"] || "Untitled")}</strong>
      <small>ID ${escapeHtml(String(record.fields["ID"] || ""))} ・ ${escapeHtml(record.fields["ステータス"] || "要照合")}</small>
    `;
    button.addEventListener("click", () => {
      selectedRecordId = record.uid;
      renderReview();
    });
    list.appendChild(button);
  });

  if (!drafts.some((record) => record.uid === selectedRecordId)) {
    selectedRecordId = drafts[0]?.uid || null;
  }
  const selected = records.find((record) => record.uid === selectedRecordId && record.workflowState !== "approved");

  $("#review-empty").hidden = Boolean(selected);
  $("#review-editor").hidden = !selected;
  $("#approve-record").disabled = !selected;
  $("#delete-record").disabled = !selected;

  if (!selected) return;

  $("#selected-subtitle").textContent = `ID ${selected.fields["ID"] || ""}`;
  $("#selected-title").textContent = `${selected.fields["アーティスト"] || "Unknown"} / ${selected.fields["タイトル"] || "Untitled"}`;
  renderFlagStrip(selected);
  renderSelectedPhotos(selected);
  renderFieldEditor(selected);
}

function renderFlagStrip(record) {
  const strip = $("#selected-flags");
  strip.innerHTML = "";
  if (!record.flags.length) {
    strip.innerHTML = `<span class="pill">確認済み</span>`;
    return;
  }
  record.flags.forEach((flag) => {
    const chip = document.createElement("span");
    chip.className = "flag-chip";
    chip.textContent = flag;
    strip.appendChild(chip);
  });
}

async function renderSelectedPhotos(record) {
  const row = $("#selected-photos");
  row.innerHTML = "";
  for (const [type, label] of [
    ["front", "ジャケ表"],
    ["back", "ジャケ裏"],
    ["disc", "A面ラベル"],
  ]) {
    const box = document.createElement("div");
    box.className = "mini-photo";
    const meta = record.photos[type];
    if (meta?.key) {
      const url = await getPhotoUrl(meta.key);
      if (url) box.style.backgroundImage = `url("${url}")`;
    }
    box.innerHTML = `<span>${escapeHtml(meta?.name || label)}</span>`;
    row.appendChild(box);
  }
}

function renderFieldEditor(record) {
  const container = $("#field-editor");
  container.innerHTML = "";

  FIELD_GROUPS.forEach((group) => {
    const section = document.createElement("section");
    section.className = "field-group";
    section.innerHTML = `<h4>${escapeHtml(group.name)}</h4><div class="field-group-grid"></div>`;
    const grid = $(".field-group-grid", section);

    group.columns.forEach((column) => {
      const row = document.createElement("div");
      const wide = ["状態メモ", "文脈タグ", "山田コメント", "販売キャプション"].includes(column);
      row.className = `field-row${wide ? " wide-field" : ""}`;
      row.appendChild(makeFieldControl(record, column));
      row.appendChild(makeFlagToggle(record, column));
      grid.appendChild(row);
    });

    container.appendChild(section);
  });
}

function makeFieldControl(record, column) {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = column;
  label.appendChild(caption);

  const value = record.fields[column] ?? "";
  let input;
  if (column === "価格判断") {
    input = makeSelect(PRICE_OPTIONS, value);
  } else if (column === "ステータス") {
    input = makeSelect(STATUS_OPTIONS, value);
  } else if (column === "棚設計5本タグ") {
    input = document.createElement("input");
    input.setAttribute("list", "shelf-options");
    input.value = value;
  } else if (["状態メモ", "山田コメント", "販売キャプション"].includes(column)) {
    input = document.createElement("textarea");
    input.rows = 3;
    input.value = value;
  } else {
    input = document.createElement("input");
    input.value = value;
    if (column === "ID") input.type = "number";
  }

  input.dataset.column = column;
  input.addEventListener("input", () => updateSelectedField(column, input.value));
  input.addEventListener("change", () => updateSelectedField(column, input.value));
  label.appendChild(input);
  return label;
}

function makeSelect(options, value) {
  const select = document.createElement("select");
  options.forEach((optionValue) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = optionValue;
    select.appendChild(option);
  });
  select.value = options.includes(value) ? value : options[0];
  return select;
}

function makeFlagToggle(record, column) {
  const label = document.createElement("label");
  label.className = "flag-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = record.flags.includes(column);
  input.addEventListener("change", () => {
    toggleFlag(record.uid, column, input.checked);
  });
  const span = document.createElement("span");
  span.textContent = "要確認";
  label.append(input, span);
  return label;
}

function updateSelectedField(column, value) {
  const record = records.find((item) => item.uid === selectedRecordId);
  if (!record) return;
  record.fields[column] = value;
  record.updatedAt = new Date().toISOString();
  saveRecords();
  renderMetrics();
  renderMaster();
  renderOperations();
}

function toggleFlag(uid, column, checked) {
  const record = records.find((item) => item.uid === uid);
  if (!record) return;
  record.flags = checked
    ? uniqueFlags([...record.flags, column])
    : record.flags.filter((flag) => flag !== column);
  record.updatedAt = new Date().toISOString();
  saveRecords();
  renderReview();
  renderMetrics();
}

function approveSelectedRecord() {
  const record = records.find((item) => item.uid === selectedRecordId);
  if (!record) return;
  record.workflowState = "approved";
  if (!record.fields["ID"]) record.fields["ID"] = nextId();
  if (record.fields["価格判断"] === "要確認") record.flags = uniqueFlags([...record.flags, "価格判断"]);
  record.updatedAt = new Date().toISOString();
  selectedRecordId = null;
  saveRecords();
  renderAll();
  setView("master");
  showToast("マスターに承認しました。");
}

function deleteSelectedRecord() {
  const record = records.find((item) => item.uid === selectedRecordId);
  if (!record) return;
  if (!confirm("この下書きを削除しますか。")) return;
  records = records.filter((item) => item.uid !== selectedRecordId);
  selectedRecordId = null;
  saveRecords();
  renderAll();
  showToast("下書きを削除しました。");
}

function renderMaster() {
  const table = $("#master-table");
  const thead = $("thead", table);
  const tbody = $("tbody", table);
  const filtered = getFilteredApprovedRecords();

  thead.innerHTML = `
    <tr>
      ${["ID", "アーティスト", "タイトル", "型番", "価格判断", "ステータス", "棚設計5本タグ", "販売導線", "同期"].map((column) => `<th>${column}</th>`).join("")}
    </tr>
  `;

  tbody.innerHTML = "";
  filtered.forEach((record) => {
    const row = document.createElement("tr");
    const cells = ["ID", "アーティスト", "タイトル", "型番", "価格判断", "ステータス", "棚設計5本タグ", "販売導線"]
      .map((column) => `<td>${escapeHtml(String(record.fields[column] ?? ""))}</td>`);
    cells.push(`<td>${record.sheetSyncedAt ? "済" : "未"}</td>`);
    row.innerHTML = cells.join("");
    tbody.appendChild(row);
  });

  if (!filtered.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="9">承認済みレコードはありません。</td>`;
    tbody.appendChild(row);
  }
}

function getFilteredApprovedRecords() {
  const query = $("#search-records").value.trim().toLowerCase();
  const price = $("#filter-price").value;
  const status = $("#filter-status").value;
  const shelf = $("#filter-shelf").value;

  return records
    .filter((record) => record.workflowState === "approved")
    .filter((record) => !price || record.fields["価格判断"] === price)
    .filter((record) => !status || record.fields["ステータス"] === status)
    .filter((record) => !shelf || String(record.fields["棚設計5本タグ"] || "").includes(shelf))
    .filter((record) => {
      if (!query) return true;
      return ["アーティスト", "タイトル", "型番", "文脈タグ", "棚設計5本タグ"].some((column) =>
        String(record.fields[column] || "").toLowerCase().includes(query),
      );
    })
    .sort((a, b) => Number(a.fields["ID"] || 0) - Number(b.fields["ID"] || 0));
}

function renderOperations() {
  const approved = records.filter((record) => record.workflowState === "approved");
  const count = approved.length;
  const batch = count % 100;
  $("#batch-label").textContent = `${batch} / 100`;
  $("#batch-progress").style.width = `${Math.min(batch, 100)}%`;

  const summary = $("#ops-summary");
  const priceCounts = PRICE_OPTIONS.filter((value) => value !== "要確認").map((price) => [
    price,
    approved.filter((record) => record.fields["価格判断"] === price).length,
  ]);
  const statusCounts = STATUS_OPTIONS.map((status) => [
    status,
    approved.filter((record) => record.fields["ステータス"] === status).length,
  ]);
  summary.innerHTML = [...priceCounts, ...statusCounts]
    .map(([label, value]) => `<div><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`)
    .join("");

  const popup = approved.filter((record) => /B｜|C｜/.test(record.fields["価格判断"] || "")).slice(0, 10);
  const specialist = approved.filter((record) => /S｜|A｜/.test(record.fields["価格判断"] || "")).slice(0, 10);
  const hold = approved.filter((record) => /文脈化保留|要照合/.test(record.fields["ステータス"] || "")).slice(0, 10);

  $("#candidate-groups").innerHTML = [
    ["POPUP候補", popup],
    ["専門店候補", specialist],
    ["保留候補", hold],
  ]
    .map(([title, items]) => renderCandidateCard(title, items))
    .join("");
}

function renderCandidateCard(title, items) {
  const list = items.length
    ? items
        .map((record) => `<li>${escapeHtml(record.fields["アーティスト"] || "")} / ${escapeHtml(record.fields["タイトル"] || "")}</li>`)
        .join("")
    : `<li>該当なし</li>`;
  return `<article class="candidate-card"><h4>${escapeHtml(title)}</h4><ul>${list}</ul></article>`;
}

function exportCsv() {
  const approved = records.filter((record) => record.workflowState === "approved");
  const lines = [
    MASTER_COLUMNS.map(csvEscape).join(","),
    ...approved.map((record) => MASTER_COLUMNS.map((column) => csvEscape(record.fields[column] ?? "")).join(",")),
  ];
  downloadFile(`oiso-master-${dateStamp()}.csv`, lines.join("\n"), "text/csv;charset=utf-8");
}

function exportJson() {
  const approved = records.filter((record) => record.workflowState === "approved");
  const payload = approved.map((record) => MASTER_COLUMNS.reduce((acc, column) => {
    acc[column] = record.fields[column] ?? "";
    return acc;
  }, {}));
  downloadFile(`oiso-master-${dateStamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function saveSyncSettings() {
  settings.syncUrl = DEFAULT_SYNC_URL;
  $("#sync-url").value = DEFAULT_SYNC_URL;
  saveSettings();
  showToast("同期先は固定済みです。");
}

async function copyConfiguredShareLink() {
  settings.syncUrl = DEFAULT_SYNC_URL;
  saveSettings();

  const url = new URL(location.href);
  url.search = "";
  url.hash = "";

  try {
    await copyText(url.toString());
    showToast("共有URLをコピーしました。");
  } catch {
    showToast("コピーできませんでした。ブラウザのURLを共有してください。");
  }
}

function getUnsyncedApprovedRecords() {
  return records.filter((record) => record.workflowState === "approved" && !record.sheetSyncedAt);
}

function resetSyncState() {
  const approved = records.filter((record) => record.workflowState === "approved");
  if (!approved.length) {
    showToast("承認済みレコードはありません。");
    return;
  }

  if (!confirm("承認済みレコードをすべて未同期に戻しますか。新しいスプレッドシートへ再送するときに使います。")) {
    return;
  }

  approved.forEach((record) => {
    delete record.sheetSyncedAt;
    record.updatedAt = new Date().toISOString();
  });
  saveRecords();
  renderAll();
  showToast(`${approved.length}件を未同期に戻しました。`);
}

function createTestApprovedRecord() {
  const now = new Date().toISOString();
  const id = nextId();
  const fields = emptyFields();

  fields["ID"] = id;
  fields["区分"] = "テスト";
  fields["アーティスト"] = "Test Artist";
  fields["タイトル"] = `Test Record ${id}`;
  fields["型番"] = `TEST-${String(id).padStart(3, "0")}`;
  fields["国"] = "Japan";
  fields["盤種・ラベル情報"] = "Label: Test Label / Year: 1978 / LP";
  fields["状態メモ"] = "同期確認用のテストデータ。送信確認後に削除できます。";
  fields["Discogs Median USD"] = "";
  fields["ディスクユニオン査定額"] = "";
  fields["Face Records想定売価"] = "";
  fields["ユーザー向け販売価格"] = "2,000-3,000円";
  fields["価格判断"] = "B｜回転良盤";
  fields["販売導線"] = "POPUP向き";
  fields["ステータス"] = "販売準備中";
  fields["文脈タグ"] = "Soul / Rare Groove / テスト";
  fields["棚設計5本タグ"] = "Cheap but Classic";
  fields["シリーズ束"] = "";
  fields["服部さん選盤候補"] = "";
  fields["記録媒体章立て候補"] = "";
  fields["山田コメント"] = "同期確認用のテストレコードです。";
  fields["販売キャプション"] = "Test Artist - Test Record。同期確認用テスト。";

  const record = {
    uid: makeUid(),
    createdAt: now,
    updatedAt: now,
    workflowState: "approved",
    input: {
      artist: fields["アーティスト"],
      title: fields["タイトル"],
      catalogNo: fields["型番"],
      country: fields["国"],
      labelName: "Test Label",
      year: "1978",
      labelInfo: "LP",
      conditionMemo: fields["状態メモ"],
      fieldNote: fields["山田コメント"],
    },
    fields,
    flags: ["テストデータ"],
    photos: {},
    analysis: {
      artist: fields["アーティスト"],
      title: fields["タイトル"],
      label: "Test Label",
      catalog_number: fields["型番"],
      country: fields["国"],
      year: "1978",
      format: "LP",
      genre_style: "Soul / Rare Groove",
      pressing: "テスト用",
      discogs_search_keywords: "Test Artist Test Record TEST-001",
      discogs_release_candidates: ["同期確認用テスト候補"],
      discogs_median_status: "未取得",
      release_identified: true,
      identification_confidence: 100,
      price_confidence: 100,
      photo_quality: "good",
      observed_facts: ["同期確認用テストデータ"],
      inferred_facts: [],
      domestic_demand_evaluation: "同期確認用",
      sell_through: "normal",
      domestic_price_low_jpy: 2000,
      domestic_price_high_jpy: 3000,
      condition_basis: "テスト用",
      du_evaluation: "不明",
      face_records_evaluation: "不明",
      bbq_records_evaluation: "不明",
      domestic_position: "同期確認用",
      popup_sales_category: fields["販売導線"],
      price_reasoning: "同期確認用",
      comment: fields["山田コメント"],
      review_required: false,
      review_reasons: ["テストデータ"],
      next_check_points: ["スプレッドシート反映確認後に削除可"],
      schemaVersion: AI_APPRAISAL_SCHEMA_VERSION,
    },
  };

  records.push(record);
  selectedRecordId = null;
  saveRecords();
  renderAll();
  setView("operations");
  showToast("未同期のテストデータを作成しました。未同期を送信でSheetsへ送れます。");
}

async function syncApprovedRecords() {
  const targets = getUnsyncedApprovedRecords();
  if (!targets.length) {
    showToast("未同期の承認済みレコードはありません。");
    return;
  }

  const batches = chunkArray(targets, 40);
  let syncedCount = 0;
  try {
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const sentAt = new Date().toISOString();
      showToast(`${targets.length}件中 ${syncedCount}件確認済み。送信中...`);
      const result = await postSheetBatch(buildSheetPayload(batch, sentAt));
      const accepted = new Set(result.acceptedUids || []);

      batch.forEach((record) => {
        if (!accepted.has(record.uid)) return;
        record.sheetSyncedAt = sentAt;
        record.updatedAt = sentAt;
        syncedCount += 1;
      });
      saveRecords();
      renderAll();
    }
    showToast(`${syncedCount}件をSheetsで受理確認しました。`);
  } catch (error) {
    saveRecords();
    renderAll();
    const prefix = syncedCount ? `${syncedCount}件は同期済み。` : "";
    showToast(`${prefix}${error.message || "Sheets同期に失敗しました。"}`);
  }
}

async function postSheetBatch(payload) {
  const accessCode = getStaffAccessCode();
  const response = await fetch(SHEETS_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Access-Code": accessCode,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    if (response.status === 401) sessionStorage.removeItem(ACCESS_TOKEN_SESSION_KEY);
    if (response.status === 404 && ["127.0.0.1", "localhost"].includes(location.hostname)) {
      throw new Error("Sheets同期はVercel公開URLで実行してください。");
    }
    throw new Error(data.error || "Sheets同期に失敗しました。");
  }
  return data;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildSheetPayload(targets, sentAt) {
  return {
    source: "oiso-record-app",
    version: 2,
    sentAt,
    columns: MASTER_COLUMNS,
    records: targets.map((record) => ({
      uid: record.uid,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      flags: record.flags,
      analysis: record.analysis || null,
      photos: Object.fromEntries(
        Object.entries(record.photos || {}).map(([type, photo]) => [
          type,
          {
            name: photo.name || "",
            size: photo.size || "",
            storageError: Boolean(photo.storageError),
          },
        ]),
      ),
      fields: MASTER_COLUMNS.reduce((acc, column) => {
        acc[column] = record.fields[column] ?? "";
        return acc;
      }, {}),
    })),
  };
}

async function clearAllData() {
  if (!records.length && recordStorageWritable) return;
  if (!confirm("全データを初期化しますか。")) return;
  records = [];
  selectedRecordId = null;
  recordStorageWritable = true;
  recordStorageError = "";
  saveRecords();
  await clearPhotoStore();
  renderAll();
  showToast("全データを初期化しました。");
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function nextId() {
  const max = records.reduce((highest, record) => Math.max(highest, Number(record.fields?.ID || 0)), 0);
  return max + 1;
}

function makeUid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `rec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("Copy failed");
}

function loadRecords() {
  const raw = localStorage.getItem(STORAGE_KEY) || "[]";
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Record data is not an array");
    return parsed;
  } catch {
    recordStorageWritable = false;
    recordStorageError = "端末内データを読み込めません。上書きを停止しました。";
    return [];
  }
}

function saveRecords() {
  if (!recordStorageWritable) {
    if ($("#toast")) showToast(recordStorageError);
    throw new Error(recordStorageError);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    recordStorageWritable = false;
    recordStorageError = "端末の保存容量が不足しています。JSONを書き出してデータを保全してください。";
    if ($("#toast")) showToast(recordStorageError);
    throw new Error(recordStorageError);
  }
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    if ("openaiKey" in parsed || "openaiModel" in parsed) {
      delete parsed.openaiKey;
      delete parsed.openaiModel;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putPhoto(key, file) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(file, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getPhotoUrl(key) {
  if (photoUrlCache.has(key)) return photoUrlCache.get(key);
  try {
    const db = await openPhotoDb();
    const blob = await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readonly");
      const request = transaction.objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    photoUrlCache.set(key, url);
    return url;
  } catch {
    return "";
  }
}

async function clearPhotoStore() {
  try {
    const db = await openPhotoDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    photoUrlCache.forEach((url) => URL.revokeObjectURL(url));
    photoUrlCache.clear();
  } catch {
    // Metadata can still be cleared even when browser storage is unavailable.
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!["http:", "https:"].includes(location.protocol)) return;
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}
