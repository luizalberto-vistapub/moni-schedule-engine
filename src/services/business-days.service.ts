import { addDays } from "../utils/dates.js";

export function isBusinessDay(date: Date, workDaysPerWeek: 5 | 6): boolean {
  const day = date.getUTCDay();
  if (day === 0) return false;
  if (workDaysPerWeek === 5 && day === 6) return false;
  return true;
}

export function nextBusinessDay(date: Date, workDaysPerWeek: 5 | 6): Date {
  let cursor = new Date(date);
  while (!isBusinessDay(cursor, workDaysPerWeek)) cursor = addDays(cursor, 1);
  return cursor;
}

export function previousBusinessDay(date: Date, workDaysPerWeek: 5 | 6): Date {
  let cursor = new Date(date);
  while (!isBusinessDay(cursor, workDaysPerWeek)) cursor = addDays(cursor, -1);
  return cursor;
}

export function addBusinessDays(date: Date, amount: number, workDaysPerWeek: 5 | 6): Date {
  if (amount === 0) return nextBusinessDay(date, workDaysPerWeek);
  const direction = amount > 0 ? 1 : -1;
  let remaining = Math.abs(amount);
  let cursor = new Date(date);

  while (remaining > 0) {
    cursor = addDays(cursor, direction);
    if (isBusinessDay(cursor, workDaysPerWeek)) remaining -= 1;
  }

  return cursor;
}