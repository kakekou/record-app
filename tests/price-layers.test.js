const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadApp() {
  const context = {
    console,
    Date,
    JSON,
    Math,
    Array,
    Object,
    Number,
    String,
    RegExp,
    Error,
    Set,
    Map,
    document: { addEventListener() {} },
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  vm.runInContext(source, context);
  return context;
}

test("migrates a legacy displayed price without treating it as human-confirmed", () => {
  const app = loadApp();
  const record = {
    uid: "123e4567-e89b-42d3-a456-426614174000",
    fields: { ユーザー向け販売価格: "2,000-3,000円" },
    flags: [],
    analysis: {
      domestic_price_low_jpy: 2000,
      domestic_price_high_jpy: 3000,
      price_confidence: 82,
    },
  };
  app.recordFixture = record;

  const migrated = vm.runInContext("migrateRecord(recordFixture)", app);
  assert.equal(migrated.fields["AI仮価格（下限円）"], 2000);
  assert.equal(migrated.fields["AI仮価格（上限円）"], 3000);
  assert.equal(migrated.fields["AI仮価格帯"], "2,000-3,000円");
  assert.equal(migrated.fields["移行前販売価格"], "2,000-3,000円");
  assert.equal(migrated.fields["人が確定した販売価格（円）"], "");
});

test("AI analysis writes only to the AI price layer", () => {
  const app = loadApp();
  const analysis = {
    artist: "Test Artist",
    title: "Test Title",
    label: "Test Label",
    catalog_number: "TEST-001",
    country: "Japan",
    year: "1978",
    format: "LP",
    genre_style: "Soul",
    matrix_runout: null,
    pressing: "Original",
    discogs_search_keywords: "Test Artist Test Title TEST-001",
    discogs_release_candidates: ["Test Artist - Test Title / TEST-001"],
    discogs_median_status: "未取得",
    release_identified: true,
    identification_confidence: 96,
    price_confidence: 81,
    photo_quality: "good",
    observed_facts: [],
    inferred_facts: [],
    domestic_demand_evaluation: "中",
    sell_through: "normal",
    domestic_price_low_jpy: 5000,
    domestic_price_high_jpy: 8000,
    condition_basis: "VG+参考",
    du_evaluation: "中",
    face_records_evaluation: "中",
    bbq_records_evaluation: "低",
    popup_sales_category: "POPUP向き",
    domestic_position: "国内流通あり",
    price_reasoning: "テスト",
    comment: "テスト",
    review_required: false,
    review_reasons: [],
    next_check_points: [],
  };
  app.analysisFixture = analysis;

  const record = vm.runInContext(`(() => {
    const fixture = {
      uid: "123e4567-e89b-42d3-a456-426614174000",
      fields: emptyFields(),
      input: {},
      flags: [],
      photos: {},
    };
    applyAnalysisToRecord(fixture, analysisFixture);
    return fixture;
  })()`, app);

  assert.equal(record.fields["AI仮価格（下限円）"], 5000);
  assert.equal(record.fields["AI仮価格（上限円）"], 8000);
  assert.equal(record.fields["AI仮価格帯"], "5,000-8,000円");
  assert.equal(record.fields["AI仮価格確信度（%）"], 81);
  assert.equal(record.fields["市場データ国内換算価格（円）"], "");
  assert.equal(record.fields["人が確定した販売価格（円）"], "");
});
