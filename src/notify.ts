// src/notify.ts
import fetch from "node-fetch";
import type { Course, DiffResult } from "./types.js";

export async function notifySlack(webhook: string, diffs: DiffResult) {
  if (!webhook) return;

  const lines: string[] = [];
  if (diffs.added.length) {
    lines.push(`追加: ${diffs.added.length}件`);
    for (const c of diffs.added.slice(0, 10)) {
      lines.push(`• [${c.id}] ${c.title} (${c.instructor}) ${c.term} ${c.dayPeriod}`);
    }
  }
  if (diffs.changed.length) {
    lines.push(`更新: ${diffs.changed.length}件`);
    for (const { after } of diffs.changed.slice(0, 10)) {
      lines.push(`• [${after.id}] ${after.title} (${after.instructor}) 更新日: ${after.updatedAt ?? "不明"} 詳細: ${after.detailUrl}`);
    }
  }
  if (diffs.removed.length) {
    lines.push(`削除: ${diffs.removed.length}件`);
    for (const c of diffs.removed.slice(0, 5)) {
      lines.push(`• [${c.id}] ${c.title}`);
    }
  }

  const text = lines.join("\n") || "差分なし";
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
}
