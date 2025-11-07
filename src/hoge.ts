// src/scrape.ts
import "dotenv/config";
import { chromium } from "playwright";
import { sleep, makeHash, normalizeText, compareCourses } from "./utils.js";
import { loadPrev, saveCurr } from "./storage.js";
import { notifySlack } from "./notify.js";
import type { Course } from "./types.js";

const BASE_URL = process.env.BASE_URL ?? "";
const SEARCH_YEAR = process.env.SEARCH_YEAR ?? "";
const OUTPUT_JSON = process.env.OUTPUT_JSON ?? "./data/courses.json";
const SLACK_WEBHOOK_URI = process.env.SLACK_WEBHOOK_URI ?? "";

if (!BASE_URL) {
  console.error("BASE_URL is required (MUSCATのシラバス検索ページURL)");
  process.exit(1);
}

async function scrapeListAndDetails(): Promise<Course[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 1) 検索ページへ
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // 2) 年度選択→検索 実DOMに合わせてここを調整
  // 例: 年度がラジオボタンの場合（labelに年度テキストがあるケース）
  if (SEARCH_YEAR) {
    const radio = await page.locator(`text=${SEARCH_YEAR}`).first();
    if (await radio.count()) {
      await radio.click();
    }
  }
  // 検索ボタン（「検索」テキストのボタン）
  const searchBtn = page.locator("button:has-text('検索'), input[type='submit'][value='検索']");
  if (await searchBtn.count()) {
    await searchBtn.first().click();
  }
  await page.waitForLoadState("networkidle");

  // 3) 一覧抽出（テーブル構造にあわせてセレクタ調整）
  let list = await page.$$eval("table tbody tr", rows => {
    const arr: { id: string; title: string; url: string; instructor: string; term: string; dayPeriod: string }[] = [];
    for (const r of rows) {
      const link = r.querySelector<HTMLAnchorElement>("a[href*='syllabus'], a[href*='detail'], a[href*='Syllabus']");
      if (!link) continue;
      const cells = Array.from(r.querySelectorAll("td")).map(td => td.textContent?.trim() || "");
      // 想定: [科目ID, 講義名, 担当, 開講期, 曜日・時限, ... , 詳細リンク]
      const id = cells[0] || "";
      const title = cells[1] || link.textContent || "";
      const instructor = cells[2] || "";
      const term = cells[3] || "";
      const dayPeriod = cells[4] || "";
      arr.push({ id, title, url: link.href, instructor, term, dayPeriod });
    }
    return arr;
  });

  if (list.length === 0) {
    // 別レイアウトのフォールバック
    list = await page.$$eval("a[href*='syllabus'], a[href*='detail']", links => {
      return Array.from(links).map(a => ({
        id: a.textContent?.trim() || a.getAttribute("href") || "",
        title: a.textContent?.trim() || "",
        url: (a as HTMLAnchorElement).href,
        instructor: "",
        term: "",
        dayPeriod: ""
      }));
    });
  }

  if (list.length === 0) {
    console.warn("検索結果の抽出に失敗。一覧テーブルのセレクタ調整が必要です。");
  }

  const courses: Course[] = [];
  const MAX_CONCURRENCY = 3;
  let i = 0;

  async function fetchDetail(item: { id: string; title: string; url: string; instructor: string; term: string; dayPeriod: string }) {
    const p = await context.newPage();
    try {
      await p.goto(item.url, { waitUntil: "domcontentloaded" });
      await p.waitForLoadState("networkidle");

      const { bodyText, updatedAt, room } = await p.evaluate(() => {
        // 本文コンテナの候補を複数用意
        const bodyEl =
          document.querySelector(".syllabus-body") ||
          document.querySelector("#content") ||
          document.querySelector("main") ||
          document.querySelector("article") ||
          document.body;
        const updated =
          document.querySelector(".updated-at")?.textContent?.trim() ||
          document.querySelector("time")?.textContent?.trim() ||
          "";
        const room =
          document.querySelector(".room")?.textContent?.trim() ||
          "";
        const text = bodyEl ? (bodyEl.textContent || "") : "";
        return { bodyText: text, updatedAt: updated, room };
      });

      const idFromUrl = (() => {
        try {
          const u = new URL(item.url);
          return u.searchParams.get("id") || item.url;
        } catch {
          return item.url;
        }
      })();

      const base: Omit<Course, "hash"> = {
        id: item.id || idFromUrl,
        title: normalizeText(item.title),
        instructor: normalizeText(item.instructor),
        term: normalizeText(item.term),
        dayPeriod: normalizeText(item.dayPeriod),
        room: normalizeText(room),
        updatedAt: normalizeText(updatedAt),
        bodyText: normalizeText(bodyText),
        detailUrl: item.url
      };
      const hash = makeHash(base);
      courses.push({ ...base, hash });
    } catch (e) {
      console.warn(`詳細取得失敗: ${item.url}`, e);
    } finally {
      await p.close();
    }
    await sleep(1000); // レート制限
  }

  const queue = list.slice();
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(MAX_CONCURRENCY, queue.length); w++) {
    workers.push((async function worker() {
      while (i < queue.length) {
        const idx = i++;
        const it = queue[idx];
        if (!it) {
          // 索引が範囲外の場合はスキップして次へ
          continue;
        }
        await fetchDetail(it);
      }
    })());
  }
  await Promise.all(workers);

  await browser.close();
  return courses;
}

async function main() {
  const prev = loadPrev(OUTPUT_JSON);
  const currArr = await scrapeListAndDetails();
  const currMap = new Map(currArr.map(c => [c.id, c]));

  const diffs = compareCourses(prev, currMap);

  await notifySlack(SLACK_WEBHOOK_URI, diffs);
  saveCurr(OUTPUT_JSON, currArr);

  console.log(`Scrape done. added=${diffs.added.length}, changed=${diffs.changed.length}, removed=${diffs.removed.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
