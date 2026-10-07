import assert from 'node:assert/strict';
import test from 'node:test';
import { isoWeek, yearProgress } from '../widgets/shared/popup-model.mjs';

test('ISO weeks cross year boundaries and include week 53', () => {
  for (const [year, month, day, week] of [
    [2021, 0, 1, 53], [2021, 0, 4, 1], [2025, 11, 29, 1], [2024, 1, 29, 9],
  ]) assert.equal(isoWeek(new Date(year, month, day, 12)), week);
});

test('year progress measures completed days, including leap years', () => {
  assert.equal(yearProgress(new Date(2026, 0, 1)), 0);
  assert.equal(yearProgress(new Date(2024, 6, 2)), 183 / 366);
  assert.equal(yearProgress(new Date(2026, 11, 31)), 364 / 365);
});
