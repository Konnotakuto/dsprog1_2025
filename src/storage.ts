// src/storage.ts
import fs from "node:fs";
import path from "node:path";
import type { Course } from "./types.js";

export function loadPrev(filePath: string): Map<string, Course> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const arr: Course[] = JSON.parse(raw);
    return new Map(arr.map(c => [c.id, c]));
  } catch {
    return new Map();
  }
}

export function saveCurr(filePath: string, courses: Course[]) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(courses, null, 2), "utf-8");
}