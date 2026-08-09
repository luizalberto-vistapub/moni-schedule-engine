export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function stableLineId(activityId: string, contextId: string | null | undefined, localIndex: number): string {
  return `${activityId}|${contextId || "sem_ambiente"}|${localIndex}`;
}
