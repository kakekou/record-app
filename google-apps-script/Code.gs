var SHEET_NAME = "48枚マスター";
var ENDPOINT_VERSION = "record-sync-v3";
var MAX_RECORDS_PER_REQUEST = 50;
var MAX_PAYLOAD_LENGTH = 500000;
var SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

var MASTER_COLUMNS = [
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
  "販売キャプション"
];

var META_COLUMNS = [
  "同期日時",
  "アプリUID",
  "要確認フラグ",
  "写真ファイル名",
  "次回確認項目",
  "Discogs候補",
  "BBQ評価",
  "AI識別確信度",
  "AI価格確信度",
  "写真品質",
  "AI要確認",
  "AI解析JSON"
];
var ALL_COLUMNS = MASTER_COLUMNS.concat(META_COLUMNS);

function doGet() {
  return jsonResponse({
    ok: true,
    message: "Record app endpoint is ready.",
    version: ENDPOINT_VERSION,
    signedRequestsRequired: true
  });
}

function doPost(e) {
  try {
    var rawPayload = getSignedPayload(e);
    var payload = JSON.parse(rawPayload);
    var records = validatePayload(payload);
    return writeRecords(payload, records);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: String(error && error.message ? error.message : error),
      version: ENDPOINT_VERSION
    });
  }
}

function getSignedPayload(e) {
  var parameter = e && e.parameter ? e.parameter : {};
  var rawPayload = String(parameter.payload || "");
  var timestamp = String(parameter.timestamp || "");
  var nonce = String(parameter.nonce || "");
  var signature = String(parameter.signature || "").toLowerCase();
  var secret = PropertiesService.getScriptProperties().getProperty("SHEETS_SYNC_SECRET") || "";

  if (secret.length < 32) throw new Error("Sheets sync secret is not configured.");
  if (!rawPayload || rawPayload.length > MAX_PAYLOAD_LENGTH) throw new Error("Invalid payload size.");
  if (!/^\d{13}$/.test(timestamp)) throw new Error("Invalid timestamp.");
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) throw new Error("Invalid nonce.");
  if (!/^[0-9a-f]{64}$/.test(signature)) throw new Error("Invalid signature.");

  var requestTime = Number(timestamp);
  if (Math.abs(Date.now() - requestTime) > SIGNATURE_MAX_AGE_MS) {
    throw new Error("Expired request.");
  }

  var expected = hmacHex(timestamp + "." + nonce + "." + rawPayload, secret);
  if (!safeEqual(expected, signature)) throw new Error("Invalid signature.");

  var cache = CacheService.getScriptCache();
  var nonceKey = "sync-nonce-" + nonce;
  if (cache.get(nonceKey)) throw new Error("Replayed request.");
  cache.put(nonceKey, "1", 600);
  return rawPayload;
}

function hmacHex(message, secret) {
  var bytes = Utilities.computeHmacSha256Signature(
    message,
    secret,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ("0" + value.toString(16)).slice(-2);
  }).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid payload.");
  }
  if (payload.source !== "oiso-record-app" || Number(payload.version) !== 2) {
    throw new Error("Unsupported payload.");
  }

  var records = Array.isArray(payload.records) ? payload.records : [];
  if (records.length < 1 || records.length > MAX_RECORDS_PER_REQUEST) {
    throw new Error("Invalid record count.");
  }

  var seen = {};
  records.forEach(function(record) {
    validateRecord(record, seen);
  });
  return records;
}

function validateRecord(record, seen) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid record.");
  }

  var uid = String(record.uid || "");
  var validUid = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|rec-\d+-[0-9a-f]+)$/i.test(uid);
  if (!validUid || seen[uid]) throw new Error("Invalid or duplicate UID.");
  seen[uid] = true;

  if (!record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) {
    throw new Error("Missing record fields.");
  }

  var keys = Object.keys(record.fields);
  if (keys.length > 60) throw new Error("Too many record fields.");
  keys.forEach(function(key) {
    var value = record.fields[key];
    var type = typeof value;
    if (String(key).length > 100
      || (value !== null && ["string", "number", "boolean"].indexOf(type) === -1)
      || String(value === null || value === undefined ? "" : value).length > 20000) {
      throw new Error("Invalid record field.");
    }
  });

  if (record.analysis && JSON.stringify(record.analysis).length > 60000) {
    throw new Error("Analysis data is too large.");
  }
}

function writeRecords(payload, records) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    var sheet = getSheet();
    var header = ensureHeader(sheet);
    var uidMap = buildUidMap(sheet, header.row, header.values.indexOf("アプリUID") + 1);
    var inserted = 0;
    var updated = 0;
    var acceptedUids = [];
    var newRows = [];

    records.forEach(function(record) {
      var rowValues = header.values.map(function(column) {
        return sheetSafeValue(valueForColumn(column, record, payload.sentAt));
      });
      var uid = String(record.uid);
      var targetRow = uidMap[uid] || 0;

      if (targetRow) {
        sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
        updated += 1;
      } else {
        newRows.push(rowValues);
        inserted += 1;
      }
      acceptedUids.push(uid);
    });

    if (newRows.length) {
      var firstInsertRow = sheet.getLastRow() + 1;
      ensureSheetCapacity(
        sheet,
        firstInsertRow + newRows.length - 1,
        header.values.length
      );
      sheet.getRange(firstInsertRow, 1, newRows.length, header.values.length).setValues(newRows);
    }

    return jsonResponse({
      ok: true,
      count: records.length,
      inserted: inserted,
      updated: updated,
      acceptedUids: acceptedUids,
      version: ENDPOINT_VERSION
    });
  } finally {
    lock.releaseLock();
  }
}

function sheetSafeValue(value) {
  if (typeof value !== "string") return value;
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(value)) return "'" + value;
  return value;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function ensureHeader(sheet) {
  ensureSheetCapacity(sheet, 1, ALL_COLUMNS.length);
  var headerRow = findHeaderRow(sheet);

  if (!headerRow) {
    sheet.getRange(1, 1, 1, ALL_COLUMNS.length).setValues([ALL_COLUMNS]);
    styleHeader(sheet, 1, ALL_COLUMNS.length);
    return { row: 1, values: ALL_COLUMNS.slice() };
  }

  var lastCol = Math.max(sheet.getLastColumn(), MASTER_COLUMNS.length);
  var values = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  while (values.length && values[values.length - 1] === "") values.pop();

  ALL_COLUMNS.forEach(function(column) {
    if (values.indexOf(column) === -1) values.push(column);
  });

  sheet.getRange(headerRow, 1, 1, values.length).setValues([values]);
  styleHeader(sheet, headerRow, values.length);
  return { row: headerRow, values: values };
}

function ensureSheetCapacity(sheet, requiredRows, requiredColumns) {
  var missingRows = requiredRows - sheet.getMaxRows();
  var missingColumns = requiredColumns - sheet.getMaxColumns();

  if (missingRows > 0) {
    sheet.insertRowsAfter(sheet.getMaxRows(), missingRows);
  }
  if (missingColumns > 0) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), missingColumns);
  }
}

function findHeaderRow(sheet) {
  var lastRow = sheet.getLastRow();
  if (!lastRow) return 0;

  var scanRows = Math.min(lastRow, 10);
  var scanCols = Math.max(sheet.getLastColumn(), MASTER_COLUMNS.length);
  var values = sheet.getRange(1, 1, scanRows, scanCols).getValues();

  for (var i = 0; i < values.length; i += 1) {
    var row = values[i].map(String);
    if (row.indexOf("ID") !== -1 && row.indexOf("アーティスト") !== -1 && row.indexOf("タイトル") !== -1) {
      return i + 1;
    }
  }
  return 0;
}

function buildUidMap(sheet, headerRow, uidColumn) {
  var map = {};
  if (!uidColumn) return map;

  var startRow = headerRow + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) return map;

  var values = sheet.getRange(startRow, uidColumn, lastRow - headerRow, 1).getValues();
  values.forEach(function(row, index) {
    if (row[0]) map[String(row[0])] = startRow + index;
  });
  return map;
}

function valueForColumn(column, record, sentAt) {
  if (MASTER_COLUMNS.indexOf(column) !== -1) {
    return record.fields && record.fields[column] !== undefined ? record.fields[column] : "";
  }
  if (column === "同期日時") return sentAt ? new Date(sentAt) : new Date();
  if (column === "アプリUID") return record.uid || "";
  if (column === "要確認フラグ") return Array.isArray(record.flags) ? record.flags.join("｜") : "";
  if (column === "写真ファイル名") return photoNames(record.photos);
  if (column === "次回確認項目") {
    if (!record.analysis || !record.analysis.next_check_points) return "";
    return Array.isArray(record.analysis.next_check_points)
      ? record.analysis.next_check_points.join("｜")
      : record.analysis.next_check_points;
  }
  if (column === "Discogs候補") {
    if (!record.analysis || !record.analysis.discogs_release_candidates) return "";
    return Array.isArray(record.analysis.discogs_release_candidates)
      ? record.analysis.discogs_release_candidates.join("｜")
      : record.analysis.discogs_release_candidates;
  }
  if (column === "BBQ評価") return record.analysis && record.analysis.bbq_records_evaluation ? record.analysis.bbq_records_evaluation : "";
  if (column === "AI識別確信度") return record.analysis && record.analysis.identification_confidence !== undefined ? record.analysis.identification_confidence : "";
  if (column === "AI価格確信度") return record.analysis && record.analysis.price_confidence !== undefined ? record.analysis.price_confidence : "";
  if (column === "写真品質") return record.analysis && record.analysis.photo_quality ? record.analysis.photo_quality : "";
  if (column === "AI要確認") return record.analysis && record.analysis.review_required ? "要確認" : "";
  if (column === "AI解析JSON") return record.analysis ? JSON.stringify(record.analysis) : "";
  return "";
}

function photoNames(photos) {
  if (!photos) return "";
  return Object.keys(photos).map(function(key) {
    return photos[key] && photos[key].name ? key + ":" + photos[key].name : "";
  }).filter(Boolean).join("｜");
}

function styleHeader(sheet, row, width) {
  var range = sheet.getRange(row, 1, 1, width);
  range.setBackground("#255f54");
  range.setFontColor("#ffffff");
  range.setFontWeight("bold");
  sheet.setFrozenRows(row);
}

function setupMasterSheet() {
  var sheet = getSheet();
  ensureHeader(sheet);
}
