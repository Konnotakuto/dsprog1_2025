// src/scrape.ts
import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE_URL = process.env.BASE_URL ?? ""; // 例: https://muscat.musashino-u.ac.jp/portal/slbssrch.do
const SEARCH_YEAR = process.env.SEARCH_YEAR ?? "2025";
const OUTPUT_JSON = process.env.OUTPUT_JSON ?? "./data/courses.json";
const USER_AGENT = process.env.USER_AGENT || undefined;

const LOGIN_URL = process.env.MUSCAT_LOGIN_URL ?? "https://muscat.musashino-u.ac.jp/";
const USER_ID = process.env.MUSCAT_USER_ID ?? "";
const PASSWORD = process.env.MUSCAT_PASSWORD ?? "";
const OTP = process.env.MUSCAT_OTP ?? "";

if (!BASE_URL) {
  console.error("BASE_URL is required");
  process.exit(1);
}
if (!USER_ID || !PASSWORD) {
  console.error("MUSCAT_USER_ID / MUSCAT_PASSWORD are required");
  process.exit(1);
}

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

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const normalizeText = (s: string) =>
  (s ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").replace(/\u00A0/g, " ").trim();

function makeHash(course: Omit<Course, "hash">): string {
  const key = [
    course.title,
    course.instructor,
    course.term,
    course.dayPeriod,
    course.room ?? "",
    course.updatedAt ?? "",
    course.bodyText
  ].map(normalizeText).join("|");
  return crypto.createHash("sha256").update(key).digest("hex");
}

function loadPrev(filePath: string): Map<string, Course> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const arr: Course[] = JSON.parse(raw);
    return new Map(arr.map(c => [c.id, c]));
  } catch {
    return new Map();
  }
}

function saveCurr(filePath: string, courses: Course[]) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(courses, null, 2), "utf-8");
}

function compareCourses(prev: Map<string, Course>, curr: Map<string, Course>) {
  const added: Course[] = [];
  const changed: { before: Course; after: Course }[] = [];
  const removed: Course[] = [];

  for (const [id, c] of curr.entries()) {
    const p = prev.get(id);
    if (!p) added.push(c);
    else if (p.hash !== c.hash) changed.push({ before: p, after: c });
  }
  for (const [id, p] of prev.entries()) {
    if (!curr.has(id)) removed.push(p);
  }
  return { added, changed, removed };
}

async function scrapeListAndDetails(): Promise<Course[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  // 1) ログイン
  console.log("Opening login:", LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  await page.fill('input[name="userId"], #userId, input[name="loginId"]', USER_ID);
  await page.fill('input[name="password"], #password', PASSWORD);

  const loginBtn = page.locator('button[type="submit"], input[type="submit"][value="ログイン"], a[href*="login"]');
  if (await loginBtn.count()) {
    await Promise.all([page.waitForLoadState("networkidle"), loginBtn.first().click()]);
    console.log("Logged in");
  } else {
    const loginForm = page.locator("form").first();
    if (await loginForm.count()) {
      await Promise.all([page.waitForLoadState("networkidle"), loginForm.evaluate(f => (f as HTMLFormElement).submit())]);
      console.log("Login form submitted (fallback)");
    } else {
      console.error("ログインフォーム/ボタンが見つからない。セレクタ要調整。");
      await browser.close();
      process.exit(1);
    }
  }

  // 2FA（必要時）
  if (await page.locator('input[name="otp"], #otp, input[name="totp"]').count()) {
    if (!OTP) {
      console.warn("2FAコード未設定。手動入力のため10秒待機…");
      await page.waitForTimeout(10000);
    } else {
      await page.fill('input[name="otp"], #otp, input[name="totp"]', OTP);
      const otpSubmit = page.locator('button[type="submit"], input[type="submit"]');
      if (await otpSubmit.count()) await otpSubmit.first().click();
      await page.waitForLoadState("networkidle");
      console.log("2FA submitted");
    }
  }

  // 2) シラバス検索へ
  console.log("Opening syllabus search:", BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // 年度選択（select）
  try {
    const hasSelect = await page.locator('select[name="nendo"], select#nendo').count();
    if (hasSelect) {
      await page.selectOption('select[name="nendo"], select#nendo', SEARCH_YEAR);
      console.log("Year selected via selectOption");
    } else {
      const firstSelect = page.locator("select").first();
      if (await firstSelect.count()) {
        await firstSelect.selectOption({ label: SEARCH_YEAR });
        console.log("Year selected via first select");
      } else {
        console.warn("Year select not found. Adjust selector.");
      }
    }
  } catch (e) {
    console.warn("Year selection failed:", e);
  }

  // 検索送信
  const searchBtn2 = page.locator("button:has-text('検索'), input[type='submit'][value='検索']");
  if (await searchBtn2.count()) {
    await Promise.all([page.waitForLoadState("networkidle"), searchBtn2.first().click()]);
    console.log("Search clicked");
  } else {
    const form2 = page.locator("form").first();
    if (await form2.count()) {
      await Promise.all([page.waitForLoadState("networkidle"), form2.evaluate(f => (f as HTMLFormElement).submit())]);
      console.log("Form submitted (fallback)");
    } else {
      console.warn("Search button/form not found.");
    }
  }

  await page.waitForLoadState("networkidle");
  console.log("Results page loaded");

  // Results page loaded の直後に差し替え

// フレーム列挙とログ
const frames = page.frames();
console.log("Frame URLs:", frames.map(f => f.url()));

// 候補: URLや見出しに "slbssrch"（シラバス検索）、"syllabus" が含まれるフレーム
let f = page.mainFrame();
const candidateByUrl = frames.find(fr => /slbssrch|syllabus|Syllabus/.test(fr.url()));
if (candidateByUrl) {
  f = candidateByUrl;
} else {
  // 見出しテキストで探索（各フレームでh1/h2に「講義一覧」があるか）
  for (const fr of frames) {
    const heading = await fr.evaluate(() => {
      const h = document.querySelector("h1, h2");
      return h ? (h.textContent || "").trim() : "";
    }).catch(() => "");
    if (heading.includes("講義一覧") || heading.includes("シラバス")) {
      f = fr;
      break;
    }
  }
}

console.log("Target frame URL:", f.url());

// テーブル抽出（No｜講義コード｜講義名｜開講期間 曜日・時限｜担当教員）
let list = await f.evaluate(() => {
  const rows = Array.from(document.querySelectorAll("table tbody tr"));
  const arr: { id: string; title: string; url: string; instructor: string; term: string; dayPeriod: string }[] = [];
  for (const r of rows) {
    const tds = Array.from(r.querySelectorAll("td"));
    if (tds.length < 5) continue;
    // 列: 0 No, 1 講義コード, 2 講義名(リンクあり), 3 開講期間・曜日時限, 4 担当教員
    const code = (tds[1].textContent || "").trim();
    const nameCell = tds[2];
    const a = nameCell.querySelector("a") as HTMLAnchorElement | null;
    const title = (a?.textContent || nameCell.textContent || "").trim();
    const url = a?.href || "";
    const schedule = (tds[3].textContent || "").trim();
    const instructor = (tds[4].textContent || "").trim();

    const termMatch = schedule.match(/(通年|前期|後期|１学期|２学期|３学期|４学期)/);
    const term = termMatch?.[1] || "";
    const dayPeriod = schedule.replace(term, "").trim();

    if (code && url) {
      arr.push({ id: code, title, url, instructor, term, dayPeriod });
    }
  }
  return arr;
});

if (list.length === 0) {
  // フォールバック: tbodyが無い場合や構造違いへの対応
  const alt = await f.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("table tr"));
    const arr: { id: string; title: string; url: string; instructor: string; term: string; dayPeriod: string }[] = [];
    for (const r of rows) {
      const tds = Array.from(r.querySelectorAll("td"));
      if (tds.length < 5) continue;
      const code = (tds[1].textContent || "").trim();
      const a = tds[2].querySelector("a") as HTMLAnchorElement | null;
      const title = (a?.textContent || tds[2].textContent || "").trim();
      const url = a?.href || "";
      const schedule = (tds[3].textContent || "").trim();
      const instructor = (tds[4].textContent || "").trim();
      const termMatch = schedule.match(/(通年|前期|後期|１学期|２学期|３学期|４学期)/);
      const term = termMatch?.[1] || "";
      const dayPeriod = schedule.replace(term, "").trim();
      if (code && url) arr.push({ id: code, title, url, instructor, term, dayPeriod });
    }
    return arr;
  });
  console.log("Fallback rows:", alt.length);
  if (alt.length === 0) {
    const snippet = await f.evaluate(() => document.body.innerHTML.slice(0, 2000));
    console.warn("Still 0 rows. Need selector fix. HTML snippet:", snippet);
    await browser.close();
    return [];
  }
  list = alt;
}

console.log("Found items (frame):", list.length);
// list already extracted from target frame above

console.log("Found items:", list.length);
  if (list.length === 0) {
    console.warn("一覧が0件。セレクタ要調整。");
    await browser.close();
    return [];
  }

  // 4) 詳細取得
  const courses: Course[] = [];
  const MAX_CONCURRENCY = 3;

  async function fetchDetail(item: { id: string; title: string; url: string; instructor: string; term: string; dayPeriod: string }) {
    const detailPage = await context.newPage();
    console.log("Fetching detail:", item.url);
    try {
      await detailPage.goto(item.url, { waitUntil: "domcontentloaded" });
      await detailPage.waitForLoadState("networkidle");

      const { bodyText, updatedAt, room } = await detailPage.evaluate(() => {
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
      await detailPage.close();
    }
    await sleep(800);
  }

  const queue = list.slice();
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(MAX_CONCURRENCY, queue.length); w++) {
    workers.push((async function worker() {
      while (queue.length) {
        const item = queue.shift();
        if (item) await fetchDetail(item);
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
  saveCurr(OUTPUT_JSON, currArr);
  console.log(`Scrape done. added=${diffs.added.length}, changed=${diffs.changed.length}, removed=${diffs.removed.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
