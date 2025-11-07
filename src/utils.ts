// src/utils.ts
import crypto from "node:crypto";
import type { Course, DiffResult } from "./types.js";

export const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export function normalizeText(s: string): string {
  return (s ?? "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

export function makeHash(course: Omit<Course, "hash">): string {
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

export function compareCourses(prev: Map<string, Course>, curr: Map<string, Course>): DiffResult {
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
