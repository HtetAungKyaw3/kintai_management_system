"use strict";
/*
 * Excel（.xlsx）を外部パッケージなしで作るモジュール。
 * 見出しの色・罫線・列幅・折り返し・先頭行の固定・フィルター・印刷設定（横向き、1ページ幅）を付けて出力する。
 * 使い方: buildXlsx([tableSheet({...}), ...]) → Buffer
 */
const zlib = require("node:zlib");

const xesc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colName(i) {
  let s = "", n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------- スタイル登録 ----------
function styleBook() {
  const fonts = ['<font><sz val="11"/><name val="Yu Gothic"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const fmts = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const seen = new Map();
  const idx = (arr, xml) => { let i = arr.indexOf(xml); if (i < 0) { arr.push(xml); i = arr.length - 1; } return i; };
  const BUILTIN = { "0": 1, "0.00": 2, "#,##0": 3, "@": 49 };

  function id(st) {
    if (!st) return 0;
    const key = JSON.stringify(st);
    if (seen.has(key)) return seen.get(key);
    const font = '<font>' + (st.b ? "<b/>" : "") + '<sz val="' + (st.sz || 11) + '"/>' +
      (st.color ? '<color rgb="FF' + st.color + '"/>' : "") + '<name val="Yu Gothic"/><family val="2"/></font>';
    const fill = st.fill ? '<fill><patternFill patternType="solid"><fgColor rgb="FF' + st.fill + '"/><bgColor indexed="64"/></patternFill></fill>' : null;
    const line = '<color rgb="FFBFBFBF"/>';
    const border = st.border ? '<border><left style="thin">' + line + '</left><right style="thin">' + line + '</right><top style="thin">' + line + '</top><bottom style="thin">' + line + '</bottom><diagonal/></border>' : null;
    let numFmtId = 0;
    if (st.fmt) {
      if (BUILTIN[st.fmt]) numFmtId = BUILTIN[st.fmt];
      else { const f = '<numFmt numFmtId="@" formatCode="' + xesc(st.fmt) + '"/>'; const i = idx(fmts, f); numFmtId = 164 + i; }
    }
    const fontId = idx(fonts, font), fillId = fill ? idx(fills, fill) : 0, borderId = border ? idx(borders, border) : 0;
    const align = '<alignment horizontal="' + (st.h || "general") + '" vertical="' + (st.v || "center") + '"' + (st.wrap ? ' wrapText="1"' : "") + "/>";
    xfs.push('<xf numFmtId="' + numFmtId + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId +
      '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + align + "</xf>");
    seen.set(key, xfs.length - 1);
    return xfs.length - 1;
  }
  function xml() {
    const numFmts = fmts.length ? '<numFmts count="' + fmts.length + '">' + fmts.map((f, i) => f.replace('numFmtId="@"', 'numFmtId="' + (164 + i) + '"')).join("") + "</numFmts>" : "";
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + numFmts +
      '<fonts count="' + fonts.length + '">' + fonts.join("") + "</fonts>" +
      '<fills count="' + fills.length + '">' + fills.join("") + "</fills>" +
      '<borders count="' + borders.length + '">' + borders.join("") + "</borders>" +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join("") + "</cellXfs>" +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }
  return { id, xml };
}

// ---------- シート ----------
function sheetXml(sh, book) {
  const rows = sh.rows || [];
  let maxCol = 0;
  const out = [];
  rows.forEach((row, ri) => {
    const cells = Array.isArray(row) ? row : row.cells;
    const h = Array.isArray(row) ? null : row.h;
    let xml = "";
    cells.forEach((c, ci) => {
      if (c === null || c === undefined) return;
      const cell = typeof c === "object" ? c : { v: c };
      const ref = colName(ci) + (ri + 1);
      const s = book.id(cell.st);
      const sa = s ? ' s="' + s + '"' : "";
      maxCol = Math.max(maxCol, ci + 1);
      if (cell.f) {
        xml += '<c r="' + ref + '"' + sa + "><f>" + xesc(cell.f) + "</f>" + (typeof cell.v === "number" ? "<v>" + cell.v + "</v>" : "") + "</c>";
      } else if (typeof cell.v === "number" && isFinite(cell.v)) {
        xml += '<c r="' + ref + '"' + sa + "><v>" + cell.v + "</v></c>";
      } else if (cell.v === "" || cell.v === null || cell.v === undefined) {
        xml += s ? '<c r="' + ref + '"' + sa + "/>" : "";
      } else {
        xml += '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + xesc(cell.v) + "</t></is></c>";
      }
    });
    out.push('<row r="' + (ri + 1) + '"' + (h ? ' ht="' + h + '" customHeight="1"' : "") + ">" + xml + "</row>");
  });

  const widths = sh.widths || [];
  const cols = widths.length ? "<cols>" + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols>" : "";
  const pane = sh.freeze ? '<pane ySplit="' + sh.freeze + '" topLeftCell="A' + (sh.freeze + 1) + '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>' : "";
  const lastRef = colName(Math.max(maxCol, 1) - 1) + Math.max(rows.length, 1);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:' + lastRef + '"/>' +
    '<sheetViews><sheetView workbookViewId="0" showGridLines="0">' + pane + "</sheetView></sheetViews>" +
    '<sheetFormatPr defaultRowHeight="20"/>' + cols +
    "<sheetData>" + out.join("") + "</sheetData>" +
    (sh.filter ? '<autoFilter ref="' + sh.filter + '"/>' : "") +
    (sh.merges && sh.merges.length ? '<mergeCells count="' + sh.merges.length + '">' + sh.merges.map((m) => '<mergeCell ref="' + m + '"/>').join("") + "</mergeCells>" : "") +
    '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="' + (sh.portrait ? "portrait" : "landscape") + '" fitToWidth="1" fitToHeight="0"/>' +
    '<headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter></worksheet>';
}

// ---------- ZIP ----------
function zipFiles(files) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  files.forEach((f) => {
    const name = Buffer.from(f.name, "utf8"), data = Buffer.from(f.data, "utf8");
    const comp = zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function safeSheetName(n, i) {
  const s = String(n || "Sheet" + (i + 1)).replace(/[\[\]:*?\/\\]/g, "-").slice(0, 31);
  return s || "Sheet" + (i + 1);
}

function buildXlsx(sheets) {
  const book = styleBook();
  const names = sheets.map((s, i) => safeSheetName(s.name, i));
  const files = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + "</Types>" },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => '<sheet name="' + xesc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + "</sheets></workbook>" },
    { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' }
  ];
  sheets.forEach((s, i) => files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: sheetXml(s, book) }));
  files.push({ name: "xl/styles.xml", data: book.xml() }); // シートを処理した後に書き出す
  return zipFiles(files);
}

// ---------- 表形式シートの組み立て ----------
const NAVY = "1F3A5F";
const ST = {
  title: { b: true, sz: 16, color: NAVY, v: "center" },
  label: { b: true, color: "595959" },
  head: { b: true, color: "FFFFFF", fill: NAVY, border: true, h: "center", wrap: true },
  text: { border: true, v: "center" },
  wrap: { border: true, wrap: true, v: "top" },
  center: { border: true, h: "center" },
  num: { border: true, h: "right", fmt: "#,##0" },
  yen: { border: true, h: "right", fmt: '"¥"#,##0' },
  total: { b: true, fill: "E8EDF4", border: true }
};

function textLines(text, width) {
  let lines = 0;
  String(text == null ? "" : text).split("\n").forEach((seg) => {
    let w = 0;
    for (const ch of seg) w += ch.charCodeAt(0) > 255 ? 2 : 1;
    lines += Math.max(1, Math.ceil(w / Math.max(1, width - 1)));
  });
  return lines;
}

/*
 * o = { name, title, meta: [[ラベル, 値]], columns: [{label, width, kind}], rows: [[値 | {v, fill, color, b}]],
 *       rowFill: (row, i) => "RRGGBB"|null, footer: [セル], sumCol: {col, label, statusCol} }
 * kind: text | wrap | center | num | yen
 */
function tableSheet(o) {
  const cols = o.columns, n = cols.length;
  const rows = [], merges = [];
  rows.push({ h: 32, cells: [{ v: o.title, st: ST.title }] });
  merges.push("A1:" + colName(Math.max(n - 1, 0)) + "1");
  (o.meta || []).forEach((m) => rows.push([{ v: m[0], st: ST.label }, { v: m[1] }]));
  rows.push([]);
  const hdr = rows.length;
  rows.push({ h: 26, cells: cols.map((c) => ({ v: c.label, st: ST.head })) });

  o.rows.forEach((r, ri) => {
    const rf = o.rowFill ? o.rowFill(r, ri) : null;
    let lines = 1;
    const cells = cols.map((c, ci) => {
      const raw = r[ci];
      const cell = raw && typeof raw === "object" ? raw : { v: raw };
      const base = ST[c.kind || "text"] || ST.text;
      const st = Object.assign({}, base);
      if (cell.fill || rf) st.fill = cell.fill || rf;
      if (cell.color) st.color = cell.color;
      if (cell.b) st.b = true;
      if (c.kind === "wrap") lines = Math.max(lines, textLines(cell.v, c.width || 20));
      return { v: cell.v === undefined || cell.v === null ? "" : cell.v, st };
    });
    rows.push(lines > 1 ? { h: Math.min(409, lines * 17 + 6), cells } : cells);
  });

  const first = hdr + 2, last = hdr + 1 + o.rows.length;
  if (o.sumCol && o.rows.length) {
    const sc = o.sumCol, L = colName(sc.col);
    const sum = o.rows.reduce((a, r) => a + ((sc.statusCol != null && r[sc.statusCol] && (r[sc.statusCol].v || r[sc.statusCol]) === "差し戻し") ? 0 : (Number(r[sc.col] && r[sc.col].v !== undefined ? r[sc.col].v : r[sc.col]) || 0)), 0);
    const cells = cols.map(() => ({ v: "", st: ST.total }));
    cells[Math.max(sc.col - 1, 0)] = { v: sc.label, st: Object.assign({}, ST.total, { h: "right" }) };
    const f = sc.statusCol != null
      ? 'SUMIF(' + colName(sc.statusCol) + first + ":" + colName(sc.statusCol) + last + ',"<>差し戻し",' + L + first + ":" + L + last + ")"
      : "SUM(" + L + first + ":" + L + last + ")";
    cells[sc.col] = { v: sum, f, st: Object.assign({}, ST.total, { h: "right", fmt: sc.yen ? '"¥"#,##0' : "#,##0" }) };
    rows.push({ h: 24, cells });
  }
  if (o.footer) rows.push({ h: 24, cells: o.footer.map((c) => ({ v: c, st: ST.total })) });

  return {
    name: o.name || o.title,
    rows, merges,
    widths: cols.map((c) => c.width || 14),
    freeze: hdr + 1,
    filter: o.rows.length ? "A" + (hdr + 1) + ":" + colName(n - 1) + (hdr + 1 + o.rows.length) : null,
    portrait: !!o.portrait
  };
}

module.exports = { buildXlsx, tableSheet };
