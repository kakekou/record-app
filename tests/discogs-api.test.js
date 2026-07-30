const assert = require("node:assert/strict");
const test = require("node:test");

const handler = require("../api/discogs-search");

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

test("requires the server-side Discogs token", async () => {
  const originalAccessToken = process.env.APP_ACCESS_TOKEN;
  const originalDiscogsToken = process.env.DISCOGS_TOKEN;
  process.env.APP_ACCESS_TOKEN = "staff-code";
  delete process.env.DISCOGS_TOKEN;

  try {
    const response = createResponse();
    await handler({
      method: "POST",
      headers: { "x-app-access-code": "staff-code" },
      body: { input: { catalogNo: "TEST-001" } },
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /Discogs APIトークン/);
  } finally {
    restoreEnvironment("APP_ACCESS_TOKEN", originalAccessToken);
    restoreEnvironment("DISCOGS_TOKEN", originalDiscogsToken);
  }
});

test("returns release metadata without Marketplace prices or images", async () => {
  const originalAccessToken = process.env.APP_ACCESS_TOKEN;
  const originalDiscogsToken = process.env.DISCOGS_TOKEN;
  const originalFetch = global.fetch;
  process.env.APP_ACCESS_TOKEN = "staff-code";
  process.env.DISCOGS_TOKEN = "discogs-token";
  let requestedUrl = "";
  let requestedOptions = null;

  global.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          results: [{
            id: 12345,
            title: "Test Artist - Test Title",
            year: "1978",
            country: "Japan",
            format: ["Vinyl", "LP"],
            label: ["Test Label"],
            catno: "TEST-001",
            uri: "/release/12345-Test-Artist-Test-Title",
            price: 99,
            lowest_price: 88,
            thumb: "https://example.com/thumb.jpg",
            cover_image: "https://example.com/cover.jpg",
          }],
        };
      },
    };
  };

  try {
    const response = createResponse();
    await handler({
      method: "POST",
      headers: { "x-app-access-code": "staff-code" },
      body: {
        input: {
          catalogNo: "TEST-001",
          artist: "Test Artist",
          title: "Test Title",
        },
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.marketDataIncluded, false);
    assert.equal(response.body.candidates.length, 1);
    assert.deepEqual(Object.keys(response.body.candidates[0]).sort(), [
      "catno",
      "country",
      "format",
      "id",
      "label",
      "title",
      "url",
      "year",
    ]);
    assert.equal(response.body.candidates[0].url, "https://www.discogs.com/release/12345-Test-Artist-Test-Title");
    assert.match(requestedUrl, /catno=TEST-001/);
    assert.equal(requestedOptions.headers.Authorization, "Discogs token=discogs-token");
    assert.match(requestedOptions.headers["User-Agent"], /OisoRecordApp/);
  } finally {
    global.fetch = originalFetch;
    restoreEnvironment("APP_ACCESS_TOKEN", originalAccessToken);
    restoreEnvironment("DISCOGS_TOKEN", originalDiscogsToken);
  }
});

test("rejects empty search conditions before calling Discogs", async () => {
  const originalAccessToken = process.env.APP_ACCESS_TOKEN;
  const originalDiscogsToken = process.env.DISCOGS_TOKEN;
  process.env.APP_ACCESS_TOKEN = "staff-code";
  process.env.DISCOGS_TOKEN = "discogs-token";

  try {
    const response = createResponse();
    await handler({
      method: "POST",
      headers: { "x-app-access-code": "staff-code" },
      body: { input: {} },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.ok, false);
  } finally {
    restoreEnvironment("APP_ACCESS_TOKEN", originalAccessToken);
    restoreEnvironment("DISCOGS_TOKEN", originalDiscogsToken);
  }
});

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
