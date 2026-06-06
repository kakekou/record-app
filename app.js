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
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DB_NAME = "oiso-record-app";
const DB_STORE = "photos";

let records = [];
let settings = {};
let selectedRecordId = null;
let activeView = "capture";
let currentFiles = {};
let toastTimer = null;
let photoUrlCache = new Map();

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
});

function bindEvents() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  $("#intake-form").addEventListener("submit", handleIntakeSubmit);
  $("#reset-form").addEventListener("click", resetIntakeForm);
  $("#save-openai-key").addEventListener("click", saveOpenAiSettings);
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
  $("#openai-key").value = settings.openaiKey || "";
  $("#openai-model").value = settings.openaiModel || DEFAULT_OPENAI_MODEL;
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
  fields["状態メモ"] = input.conditionMemo || "";
  fields["価格判断"] = "要確認";
  fields["販売導線"] = "未判断";
  fields["ステータス"] = inferStatus(input);
  fields["文脈タグ"] = contextTags;
  fields["棚設計5本タグ"] = shelf;
  fields["山田コメント"] = input.fieldNote || "";
  fields["販売キャプション"] = buildCaptionDraft(input);

  const flags = uniqueFlags([
    !input.catalogNo && "型番",
    !country && "国",
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
    input.labelInfo,
  ].filter(Boolean).join(" / ");
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

function saveOpenAiSettings() {
  settings.openaiKey = $("#openai-key").value.trim();
  settings.openaiModel = $("#openai-model").value || DEFAULT_OPENAI_MODEL;
  saveSettings();
  showToast("OpenAI設定を保存しました。");
}

async function analyzeWithOpenAI() {
  const apiKey = ($("#openai-key").value || settings.openaiKey || "").trim();
  const model = $("#openai-model").value || settings.openaiModel || DEFAULT_OPENAI_MODEL;
  const input = getIntakeData();
  const files = Object.entries(currentFiles).filter(([, file]) => file);

  if (!apiKey) {
    setAiStatus("APIキーを入力してください。", "error");
    $("#openai-key").focus();
    return;
  }

  if (!files.length) {
    setAiStatus("写真を1枚以上選択してください。", "error");
    return;
  }

  settings.openaiKey = apiKey;
  settings.openaiModel = model;
  saveSettings();

  setAiStatus("画像を圧縮しています...", "running");
  $("#analyze-openai").disabled = true;

  try {
    const images = [];
    for (const [type, file] of files) {
      images.push({ type, dataUrl: await fileToResizedDataUrl(file) });
    }

    setAiStatus("OpenAIでラフ査定中...", "running");
    const analysis = await requestOpenAIAnalysis(apiKey, model, input, images);
    const record = createDraftRecord(input);
    applyAnalysisToRecord(record, analysis);
    await attachPhotos(record);
    records.push(record);
    selectedRecordId = record.uid;
    saveRecords();
    resetIntakeForm();
    renderAll();
    setView("review");
    setAiStatus("ラフ査定から下書きを作成しました。", "success");
    showToast("OpenAIラフ査定から下書きを作成しました。");
  } catch (error) {
    setAiStatus(`査定に失敗しました: ${error.message}`, "error");
  } finally {
    $("#analyze-openai").disabled = false;
  }
}

async function requestOpenAIAnalysis(apiKey, model, input, images) {
  const content = [
    { type: "input_text", text: buildAnalysisPrompt(input) },
    ...images.map((image) => ({
      type: "input_image",
      image_url: image.dataUrl,
      detail: "low",
    })),
  ];

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
      max_output_tokens: 1800,
      text: {
        format: {
          type: "json_schema",
          name: "rough_record_appraisal",
          strict: true,
          schema: analysisJsonSchema(),
        },
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI API error ${response.status}`);
  }

  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAIからJSON本文を取得できませんでした。");

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("OpenAIの返却JSONを解析できませんでした。");
  }
}

function buildAnalysisPrompt(input) {
  return [
    "以下のレコード画像と入力補足を解析し、まずは大枠のレコード査定下書きを作成してください。",
    "",
    "今回の目的:",
    "- 正確な最終査定ではなく、後で人間が直せるラフな下書きを作る。",
    "- Discogs候補、DU評価、Face評価、BBQ評価の精密化は後工程で行う。",
    "- 写真から読めない情報は空欄にし、不確実性フラグに入れる。",
    "",
    "判断の優先順位:",
    "1. 国内DJ需要",
    "2. 日本中古市場での流通性",
    "3. POPUPでの手離れ",
    "4. 海外Discogs価格",
    "5. コレクター性",
    "",
    "ラフ価格判断ルール:",
    "- 状態補正を考慮してください。EX / VG+ / VG 想定。",
    "- 帯付き国内盤は加点してください。",
    "- 日本DJ需要を優先してください。",
    "- 海外高騰のみの盤は国内補正してください。",
    "- 再発盤は適正補正してください。",
    "- 売れる速度も考慮してください。",
    "- 価格は一点価格ではなく、ざっくりした日本円レンジで返してください。",
    "",
    "返却フィールドの考え方:",
    "- rough_price_rank は S / A / B / C のどれかで返してください。",
    "- rough_price_range_jpy は 例: 2,000-3,500円 のようなレンジで返してください。",
    "- sales_category は 即売向き / POPUP向き / 高額保留 / 業者流し向き / 要確認 のいずれかを基本にしてください。",
    "- shelf_tags は Jacket Graffiti / Night Window / Cheap but Classic / 和帯の余白 / Sleeper's Choice から1〜2個を ｜ 区切りで返してください。",
    "- next_check_points には、最終査定で確認すべき型番・盤質・付属品・相場照合などを書いてください。",
    "",
    "入力補足:",
    `Artist: ${input.artist || ""}`,
    `Title: ${input.title || ""}`,
    `Label: ${input.labelName || ""}`,
    `Catalog Number: ${input.catalogNo || ""}`,
    `Country: ${input.country || ""}`,
    `Year: ${input.year || ""}`,
    `盤種ラベル情報: ${input.labelInfo || ""}`,
    `状態メモ: ${input.conditionMemo || ""}`,
    `現場所見: ${input.fieldNote || ""}`,
    "",
    "国内中古レコード店バイヤー視点で、日本語中心の簡潔なJSONを返してください。",
  ].join("\n");
}

function analysisJsonSchema() {
  const stringField = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "artist",
      "title",
      "label",
      "catalog_number",
      "country",
      "year",
      "format",
      "genre_style",
      "pressing",
      "rough_price_rank",
      "rough_price_range_jpy",
      "domestic_position",
      "sales_category",
      "shelf_tags",
      "short_comment",
      "next_check_points",
      "uncertainty_flags",
    ],
    properties: {
      artist: stringField,
      title: stringField,
      label: stringField,
      catalog_number: stringField,
      country: stringField,
      year: stringField,
      format: stringField,
      genre_style: stringField,
      pressing: stringField,
      rough_price_rank: stringField,
      rough_price_range_jpy: stringField,
      domestic_position: stringField,
      sales_category: stringField,
      shelf_tags: stringField,
      short_comment: stringField,
      next_check_points: stringField,
      uncertainty_flags: {
        type: "array",
        items: stringField,
      },
    },
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

function applyAnalysisToRecord(record, analysis) {
  const fields = record.fields;
  fields["アーティスト"] = analysis.artist || fields["アーティスト"];
  fields["タイトル"] = analysis.title || fields["タイトル"];
  fields["型番"] = analysis.catalog_number || fields["型番"];
  fields["国"] = analysis.country || fields["国"];
  fields["盤種・ラベル情報"] = compactText([
    analysis.label && `Label: ${analysis.label}`,
    analysis.year && `Year: ${analysis.year}`,
    analysis.format,
    analysis.pressing,
    fields["盤種・ラベル情報"],
  ], " / ");
  fields["Discogs Median USD"] = "";
  fields["ディスクユニオン査定額"] = "";
  fields["Face Records想定売価"] = "";
  fields["ユーザー向け販売価格"] = analysis.rough_price_range_jpy || "";
  fields["価格判断"] = priceRankFromAnalysis(analysis);
  fields["販売導線"] = analysis.sales_category || fields["販売導線"];
  fields["ステータス"] = statusFromAnalysis(fields["価格判断"], analysis);
  fields["文脈タグ"] = compactText([
    analysis.genre_style,
    analysis.domestic_position,
  ], " / ");
  fields["棚設計5本タグ"] = analysis.shelf_tags || shelfFromAnalysis(analysis) || fields["棚設計5本タグ"];
  fields["山田コメント"] = analysis.short_comment || fields["山田コメント"];
  fields["販売キャプション"] = buildAnalysisCaption(analysis);
  record.analysis = analysis;
  record.flags = uniqueFlags([
    ...(record.flags || []),
    ...(analysis.uncertainty_flags || []),
    "Discogs Median USD",
    "DU/Face/BBQ精密査定",
    !analysis.rough_price_range_jpy && "ユーザー向け販売価格",
    !analysis.catalog_number && "型番",
  ]);
  record.updatedAt = new Date().toISOString();
}

function priceRankFromAnalysis(analysis) {
  const explicitRank = String(analysis.rough_price_rank || "");
  if (/^S/.test(explicitRank)) return "S｜高額・個別管理";
  if (/^A/.test(explicitRank)) return "A｜中高額良盤";
  if (/^B/.test(explicitRank)) return "B｜回転良盤";
  if (/^C/.test(explicitRank)) return "C｜入口商品";
  const salePrice = numberFromText(analysis.rough_price_range_jpy);
  const category = `${analysis.sales_category || ""} ${analysis.short_comment || ""}`;
  if (/高額|個別|保留|プレミアム/.test(category) || salePrice >= 10000) return "S｜高額・個別管理";
  if (salePrice >= 4500) return "A｜中高額良盤";
  if (salePrice >= 1800) return "B｜回転良盤";
  return "C｜入口商品";
}

function statusFromAnalysis(priceRank, analysis) {
  const text = `${analysis.sales_category || ""} ${analysis.short_comment || ""} ${analysis.next_check_points || ""}`;
  if (priceRank.startsWith("S") || /高額保留|個別/.test(text)) return "個別管理";
  if (/要確認|不確|型番違い|候補/.test(text)) return "要照合";
  return "販売準備中";
}

function shelfFromAnalysis(analysis) {
  const text = `${analysis.genre_style || ""} ${analysis.domestic_position || ""} ${analysis.short_comment || ""}`.toLowerCase();
  const shelves = [];
  if (/帯|日本盤|city pop|和物/.test(text)) shelves.push("和帯の余白");
  if (/ambient|balearic|aor|mellow|city|夜|都市|dub/.test(text)) shelves.push("Night Window");
  if (/入口|即売|classic|定番|回転/.test(text)) shelves.push("Cheap but Classic");
  if (/jacket|cover|アート|ジャケ|デザイン/.test(text)) shelves.push("Jacket Graffiti");
  if (!shelves.length) shelves.push("Sleeper's Choice");
  return shelves.slice(0, 2).join("｜");
}

function buildAnalysisCaption(analysis) {
  const title = compactText([analysis.artist, analysis.title], " - ");
  const context = compactText([analysis.genre_style, analysis.domestic_position], " / ");
  if (!title) return analysis.short_comment || "";
  return compactText([title, context, analysis.short_comment], "。");
}

function compactText(items, separator) {
  return items.map((item) => String(item || "").trim()).filter(Boolean).join(separator);
}

function numberFromText(value) {
  const match = String(value || "").replace(/,/g, "").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function setAiStatus(message, state) {
  const status = $("#ai-status");
  status.textContent = message;
  status.dataset.state = state || "";
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
    ["disc", "盤面"],
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
      rough_price_rank: "B",
      rough_price_range_jpy: fields["ユーザー向け販売価格"],
      domestic_position: "同期確認用",
      sales_category: fields["販売導線"],
      shelf_tags: fields["棚設計5本タグ"],
      short_comment: fields["山田コメント"],
      next_check_points: "スプレッドシート反映確認後に削除可",
      uncertainty_flags: ["テストデータ"],
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
  const endpoint = DEFAULT_SYNC_URL;
  if (!endpoint) {
    showToast("Apps Script WebアプリURLを設定してください。");
    setView("operations");
    $("#sync-url").focus();
    return;
  }

  const targets = getUnsyncedApprovedRecords();
  if (!targets.length) {
    showToast("未同期の承認済みレコードはありません。");
    return;
  }

  settings.syncUrl = endpoint;
  $("#sync-url").value = endpoint;
  saveSettings();

  const sentAt = new Date().toISOString();
  const payload = buildSheetPayload(targets, sentAt);

  try {
    showToast(`${targets.length}件をSheetsへ送信中です...`);
    await postPayloadViaForm(endpoint, payload);

    targets.forEach((record) => {
      record.sheetSyncedAt = sentAt;
      record.updatedAt = sentAt;
    });
    saveRecords();
    renderAll();
    showToast(`${targets.length}件をSheetsへ送信しました。シート側で確認してください。`);
  } catch {
    showToast("Sheets同期に失敗しました。URLやデプロイ設定を確認してください。");
  }
}

function postPayloadViaForm(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const frameName = `sheet-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const iframe = document.createElement("iframe");
    const form = document.createElement("form");
    const input = document.createElement("input");
    let submitted = false;

    const cleanup = () => {
      iframe.remove();
      form.remove();
    };

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Sheets送信がタイムアウトしました。"));
    }, 30000);

    iframe.name = frameName;
    iframe.hidden = true;
    iframe.addEventListener("load", () => {
      if (!submitted) return;
      window.clearTimeout(timer);
      cleanup();
      resolve();
    });

    form.action = endpoint;
    form.method = "POST";
    form.target = frameName;
    form.enctype = "application/x-www-form-urlencoded";
    form.hidden = true;

    input.type = "hidden";
    input.name = "payload";
    input.value = JSON.stringify(payload);

    form.appendChild(input);
    document.body.append(iframe, form);
    submitted = true;
    form.submit();
  });
}

function buildSheetPayload(targets, sentAt) {
  return {
    source: "oiso-record-app",
    version: 1,
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
  if (!records.length) return;
  if (!confirm("全データを初期化しますか。")) return;
  records = [];
  selectedRecordId = null;
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
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
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
