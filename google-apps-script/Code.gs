var SHEET_NAME = "48枚マスター";

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
  var sheet = getSheet();
  ensureHeader(sheet);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return jsonResponse({
    ok: true,
    message: "Oiso record app endpoint is ready.",
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    sheetName: sheet.getName()
  });
}

function doPost(e) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    var payload = parsePayload(e);
    var records = Array.isArray(payload.records) ? payload.records : [];

    if (records.length === 0) {
      return jsonResponse({ ok: false, error: "No records received." });
    }

    var sheet = getSheet();
    var header = ensureHeader(sheet);
    var uidMap = buildUidMap(sheet, header.row, header.values.indexOf("アプリUID") + 1);
    var inserted = 0;
    var updated = 0;

    records.forEach(function(record) {
      var rowValues = header.values.map(function(column) {
        return valueForColumn(column, record, payload.sentAt);
      });
      var uid = record.uid || "";
      var targetRow = uid ? uidMap[uid] : 0;

      if (targetRow) {
        sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
        updated += 1;
      } else {
        sheet.appendRow(rowValues);
        inserted += 1;
      }
    });

    return jsonResponse({ ok: true, count: records.length, inserted: inserted, updated: updated });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) });
  } finally {
    lock.releaseLock();
  }
}

function parsePayload(e) {
  if (e && e.parameter && e.parameter.payload) {
    return JSON.parse(e.parameter.payload);
  }

  var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
  if (/^\s*payload=/.test(raw)) {
    var encoded = raw.replace(/^\s*payload=/, "").replace(/\+/g, "%20");
    return JSON.parse(decodeURIComponent(encoded));
  }

  return JSON.parse(raw);
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
