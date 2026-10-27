import '../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldAccents, slugify, normalizeTags, stripMarkdown, makeExcerpt, readingTimeMinutes, tokenize, toAsciiSubject, SLUG_RE,
} from '../../src/lib/text.mjs';
import { uuidv7, isUuid } from '../../src/lib/ids.mjs';

test('foldAccents removes diacritics and ligatures', () => {
  assert.equal(foldAccents("Éléphant à l'œil ça"), "Elephant a l'oeil ca");
});

test('slugify builds URL-safe slugs', () => {
  assert.equal(slugify('  Mon Premier Article : Lambda & DynamoDB ! '), 'mon-premier-article-lambda-dynamodb');
  assert.equal(slugify('---'), '');
  const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(30), 80);
  assert.ok(long.length <= 80);
  assert.match(long, SLUG_RE);
});

test('normalizeTags lowercases, slugifies and de-duplicates', () => {
  assert.deepEqual(normalizeTags(['AWS', 'aws', ' Serverless Computing ', '', '!!!', 'Café']), ['aws', 'serverless-computing', 'cafe']);
});

test('stripMarkdown and excerpt', () => {
  const md = '# Titre\n\nUn **texte** avec un [lien](https://x.y) et ![image](a.png).\n\n```js\ncode()\n```\n- item';
  assert.equal(stripMarkdown(md), 'Titre Un texte avec un lien et image. item');
  const excerpt = makeExcerpt('mot '.repeat(100), 50);
  assert.ok(excerpt.length <= 50);
  assert.ok(excerpt.endsWith('…'));
  assert.equal(makeExcerpt('court'), 'court');
});

test('readingTimeMinutes has a minimum of one minute', () => {
  assert.equal(readingTimeMinutes(''), 1);
  assert.equal(readingTimeMinutes('mot '.repeat(401)), 3);
});

test('tokenize normalises and removes stop words', () => {
  assert.deepEqual(tokenize("L'architecture Serverless avec AWS Lambda et l'IA, c'est génial"), [
    'architecture', 'serverless', 'aws', 'lambda', 'ia', 'genial',
  ]);
  assert.deepEqual(tokenize('AI is the future of the web'), ['ai', 'future', 'web']);
});

test('toAsciiSubject produces SNS-compatible subjects', () => {
  assert.equal(toAsciiSubject('Nouvel article : «Été» — déjà là…'), 'Nouvel article : "Ete" - deja la...');
  const subject = toAsciiSubject('x'.repeat(200));
  assert.equal(subject.length, 99);
  assert.equal(toAsciiSubject('🚀🚀'), 'Blogify');
});

test('uuidv7 is valid, version 7 and time ordered', () => {
  const ids = Array.from({ length: 2000 }, () => uuidv7());
  for (const id of ids) {
    assert.ok(isUuid(id));
    assert.equal(id[14], '7');
    assert.ok(['8', '9', 'a', 'b'].includes(id[19]));
  }
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids);
  assert.equal(new Set(ids).size, ids.length);
});
