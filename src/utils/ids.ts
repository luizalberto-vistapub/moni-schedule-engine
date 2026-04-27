export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function stableLineId(activityId: string, date: string, cloneIndex: number): string {
  return `${activityId}_${date}_${cloneIndex}`;
}