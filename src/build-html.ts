// src/build-html.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

type Course = {
  id: string;
  title: string;
  instructor: string;
  term: string;
  dayPeriod: string;
  room?: string;
  updatedAt?: string;
  bodyText: string;
  detailUrl: string;
  hash: string;
};

const OUTPUT_JSON = process.env.OUTPUT_JSON ?? "./data/courses.json";
const OUTPUT_HTML = process.env.OUTPUT_HTML ?? "./public/index.html";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function main() {
  let arr: Course[] = [];
  try {
    const raw = fs.readFileSync(OUTPUT_JSON, "utf-8");
    arr = JSON.parse(raw);
  } catch {
    console.error(`JSON読み込み失敗: ${OUTPUT_JSON}`);
    process.exit(1);
  }

  arr.sort((a, b) => a.title.localeCompare(b.title, "ja"));

  const rows = arr.map(c => `
    <tr>
      <td>${escapeHtml(c.id)}</td>
      <td><a href="${escapeHtml(c.detailUrl)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a></td>
      <td>${escapeHtml(c.instructor)}</td>
      <td>${escapeHtml(c.term)}</td>
      <td>${escapeHtml(c.dayPeriod)}</td>
      <td>${escapeHtml(c.room ?? "")}</td>
      <td>${escapeHtml(c.updatedAt ?? "")}</td>
    </tr>
  `).join("");

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>MUSCAT シラバス一覧</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans JP", sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #f4f4f4; }
  </style>
</head>
<body>
  <h1>MUSCAT シラバス一覧（静的生成）</h1>
  <table>
    <thead>
      <tr>
        <th>科目ID</th>
        <th>講義名</th>
        <th>担当</th>
        <th>開講期</th>
        <th>曜日・時限</th>
        <th>教室</th>
        <th>更新日</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;

  const dir = path.dirname(OUTPUT_HTML);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_HTML, html, "utf-8");
  console.log(`HTML generated: ${OUTPUT_HTML}`);
}

main();
