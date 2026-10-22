// The month a date picker shows. Plain functions, tested without a window.
import { daysIn, weekday } from "./form";

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Monday first. */
export const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** The weeks of a month, each seven cells from Monday: the day of the month, or nothing outside it. */
export function monthGrid(year: number, month: number): (number | undefined)[][] {
  const lead = weekday(year, month, 1);
  const days = daysIn(year, month);
  const cells: (number | undefined)[] = [
    ...Array.from({ length: lead }, () => undefined),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(undefined);
  const weeks: (number | undefined)[][] = [];
  for (let at = 0; at < cells.length; at += 7) weeks.push(cells.slice(at, at + 7));
  return weeks;
}

/** The month `by` months from this one, rolling over the year. */
export function shiftMonth(
  year: number,
  month: number,
  by: number,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}
