const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SECRET = "0123456789abcdef0123456789abcdef";

function loadCodeGs() {
  const cache = new Map();
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
    Utilities: {
      Charset: { UTF_8: "UTF-8" },
      computeHmacSha256Signature(message, secret) {
        return Array.from(crypto.createHmac("sha256", secret).update(message).digest())
          .map((value) => (value > 127 ? value - 256 : value));
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty: () => SECRET };
      },
    },
    CacheService: {
      getScriptCache() {
        return {
          get: (key) => cache.get(key),
          put: (key, value) => cache.set(key, value),
        };
      },
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "google-apps-script", "Code.gs"),
    "utf8",
  );
  vm.runInContext(source, context);
  return context;
}

test("neutralizes spreadsheet formulas but preserves ordinary text", () => {
  const code = loadCodeGs();
  assert.equal(code.sheetSafeValue("=HYPERLINK(\"https://example.com\")"), "'=HYPERLINK(\"https://example.com\")");
  assert.equal(code.sheetSafeValue("  +123"), "'  +123");
  assert.equal(code.sheetSafeValue("Artist Name"), "Artist Name");
  assert.equal(code.sheetSafeValue(123), 123);
});

test("accepts a correctly signed request and rejects replay", () => {
  const code = loadCodeGs();
  const payload = JSON.stringify({ source: "oiso-record-app", version: 2, records: [] });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(`${timestamp}.${nonce}.${payload}`)
    .digest("hex");
  const event = { parameter: { payload, timestamp, nonce, signature } };

  assert.equal(code.getSignedPayload(event), payload);
  assert.throws(() => code.getSignedPayload(event), /Replayed request/);
});

test("keeps AI, market, human-confirmed, and sold prices in separate columns", () => {
  const code = loadCodeGs();
  [
    "AI仮価格（下限円）",
    "AI仮価格（上限円）",
    "市場データ国内換算価格（円）",
    "人が確定した販売価格（円）",
    "価格確定者",
    "価格確定日時",
    "実売価格（円）",
  ].forEach((column) => {
    assert.equal(code.MASTER_COLUMNS.includes(column), true, `${column} is missing`);
  });
});

test("stores the human-selected Discogs release without Marketplace data", () => {
  const code = loadCodeGs();
  [
    "Discogs Release ID",
    "Discogs Release URL",
    "Discogs照合日時",
  ].forEach((column) => {
    assert.equal(code.MASTER_COLUMNS.includes(column), true, `${column} is missing`);
  });
  assert.equal(code.ENDPOINT_VERSION, "record-sync-v5");
});
