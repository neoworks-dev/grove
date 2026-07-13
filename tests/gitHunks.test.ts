import { describe, expect, test } from 'bun:test'
import { parseHunks } from '../src/main/git'

describe('parseHunks', () => {
  test('reads explicit start,count on both sides', () => {
    const diff = `@@ -10,3 +10,5 @@ function foo()\n context`
    expect(parseHunks(diff)).toEqual([
      { originalStart: 10, originalCount: 3, modifiedStart: 10, modifiedCount: 5 }
    ])
  })

  test('omitted count means 1', () => {
    const diff = `@@ -4 +4 @@`
    expect(parseHunks(diff)).toEqual([
      { originalStart: 4, originalCount: 1, modifiedStart: 4, modifiedCount: 1 }
    ])
  })

  test('pure insertion has originalCount 0', () => {
    const diff = `@@ -0,0 +1,7 @@`
    expect(parseHunks(diff)).toEqual([
      { originalStart: 0, originalCount: 0, modifiedStart: 1, modifiedCount: 7 }
    ])
  })

  test('pure deletion has modifiedCount 0', () => {
    const diff = `@@ -12,4 +11,0 @@`
    expect(parseHunks(diff)).toEqual([
      { originalStart: 12, originalCount: 4, modifiedStart: 11, modifiedCount: 0 }
    ])
  })

  test('parses several hunks in one diff', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+extra',
      '@@ -20,2 +21,0 @@',
      '-gone',
      '-gone2'
    ].join('\n')
    expect(parseHunks(diff)).toEqual([
      { originalStart: 1, originalCount: 1, modifiedStart: 1, modifiedCount: 2 },
      { originalStart: 20, originalCount: 2, modifiedStart: 21, modifiedCount: 0 }
    ])
  })

  test('no hunks yields empty list', () => {
    expect(parseHunks('')).toEqual([])
  })
})
