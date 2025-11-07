// src/types.ts
export type Course = {
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

export type DiffResult = {
  added: Course[];
  changed: { before: Course; after: Course }[];
  removed: Course[];
};
