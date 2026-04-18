export interface WindowedCounter {
  windowMs: number;
  limit: number;
  recent: number[];
}

export function allow(c: WindowedCounter, nowMs: number): boolean {
  const cutoff = nowMs - c.windowMs;
  while (c.recent.length > 0 && c.recent[0]! <= cutoff) {
    c.recent.shift();
  }
  if (c.recent.length > c.limit) return false;
  c.recent.push(nowMs);
  return true;
}
