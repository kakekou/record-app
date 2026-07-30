const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const handler = require("../api/sync");

const ACCESS_TOKEN = "staff-access-token";
const SYNC_SECRET = "0123456789abcdef0123456789abcdef";
const ENDPOINT = "https://script.google.com/macros/s/test-deployment/exec";

function makeRequest(overrides = {}) {
  return {
    method: "POST",
    headers: { "x-app-access-code": ACCESS_TOKEN },
    body: makePayload(),
    ...overrides,
  };
}

function makePayload() {
  return {
    source: "oiso-record-app",
    version: 2,
    sentAt: new Date().toISOString(),
    records: [{
      uid: "123e4567-e89b-42d3-a456-426614174000",
      fields: {
        ID: 1,
        アーティスト: "Test Artist",
        タイトル: "Test Title",
      },
      flags: [],
      photos: {},
      analysis: null,
    }],
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function setEnvironment() {
  process.env.APP_ACCESS_TOKEN = ACCESS_TOKEN;
  process.env.SHEETS_WEB_APP_URL = ENDPOINT;
  process.env.SHEETS_SYNC_SECRET = SYNC_SECRET;
}

test.beforeEach(() => {
  setEnvironment();
});

test.afterEach(() => {
  delete global.fetch;
});

test("rejects requests without the staff access code", async () => {
  const response = makeResponse();
  await handler(makeRequest({ headers: {} }), response);
  assert.equal(response.statusCode, 401);
});

test("rejects malformed record UIDs before contacting Sheets", async () => {
  const payload = makePayload();
  payload.records[0].uid = "not-a-uid";
  const response = makeResponse();
  await handler(makeRequest({ body: payload }), response);
  assert.equal(response.statusCode, 400);
});

test("signs the exact payload and verifies accepted UIDs", async () => {
  let forwarded;
  global.fetch = async (url, options) => {
    forwarded = { url, options };
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          ok: true,
          count: 1,
          inserted: 1,
          updated: 0,
          acceptedUids: ["123e4567-e89b-42d3-a456-426614174000"],
          version: "record-sync-v4",
        });
      },
    };
  };

  const response = makeResponse();
  await handler(makeRequest(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(forwarded.url, ENDPOINT);
  const form = new URLSearchParams(forwarded.options.body);
  const signedText = `${form.get("timestamp")}.${form.get("nonce")}.${form.get("payload")}`;
  const expected = crypto.createHmac("sha256", SYNC_SECRET).update(signedText).digest("hex");
  assert.equal(form.get("signature"), expected);
  assert.deepEqual(response.body.acceptedUids, ["123e4567-e89b-42d3-a456-426614174000"]);
});

test("does not mark a batch accepted when Sheets returns different UIDs", async () => {
  global.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        ok: true,
        count: 1,
        acceptedUids: ["123e4567-e89b-42d3-a456-426614174999"],
      });
    },
  });

  const response = makeResponse();
  await handler(makeRequest(), response);
  assert.equal(response.statusCode, 502);
});
