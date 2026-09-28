const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const words = require('../supabase/functions/_shared/word-list.json');
const wordSet = new Set(words);

test('bundled English list contains a broad playable vocabulary', () => {
  assert.ok(words.length >= 90_000);
  assert.equal(wordSet.size, words.length);
  assert.ok(words.every(word => /^[a-z]{8,32}$/.test(word)));
});

test('bundled list includes US and UK spellings and uncommon words', () => {
  for (const word of ['coloring', 'colouring', 'acclimatization', 'unquestionably']) {
    assert.ok(wordSet.has(word), `expected the list to include ${word}`);
  }
});

test('word list distribution includes its required source notice', () => {
  const notice = readFileSync(path.join(__dirname, '..', 'word-list-license.txt'), 'utf8');
  assert.match(notice, /Copyright 2000-2026 by Kevin Atkinson/);
  assert.match(notice, /Permission to use, copy, modify, distribute, and sell/);
});
