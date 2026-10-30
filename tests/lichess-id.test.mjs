import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLichessGameId, parseLichessFlip } from '../lichess.js';

test('8-char game ids and 12-char ids with a player token reduce to the 8-char id', () => {
  assert.deepEqual(parseLichessGameId('https://lichess.org/CZmytj0X'), { id: 'CZmytj0X' });
  assert.deepEqual(parseLichessGameId('https://lichess.org/CZmytj0X/black/analysis'), { id: 'CZmytj0X' });
  assert.deepEqual(parseLichessGameId('https://lichess.org/CZmytj0XNUnq'), { id: 'CZmytj0X' });
  assert.deepEqual(parseLichessGameId('/CZmytj0X?color=white#12'), { id: 'CZmytj0X' });
});

test('current /game/<id> URLs parse the same as the older /<id> form', () => {
  assert.deepEqual(parseLichessGameId('https://lichess.org/game/CZmytj0X'), { id: 'CZmytj0X' });
  assert.deepEqual(parseLichessGameId('https://lichess.org/game/CZmytj0X/black'), { id: 'CZmytj0X' });
  assert.deepEqual(parseLichessGameId('https://lichess.org/game/CZmytj0XNUnq/white/analysis'), { id: 'CZmytj0X' });
  // The colour/flip helpers keep working on the new route too.
  assert.equal(parseLichessFlip('https://lichess.org/game/CZmytj0X/black'), true);
  assert.equal(parseLichessFlip('https://lichess.org/game/CZmytj0X/white'), false);
});

test('route names that happen to be 8-12 letters are never game ids', () => {
  for (const route of ['training', 'analysis', 'practice', 'streamer', 'tournament', 'broadcast']) {
    assert.equal(parseLichessGameId(`https://lichess.org/${route}`), null, route);
  }
  // 9-11 character segments (e.g. /dashboard, /community, /Developer) are routes, not games.
  for (const route of ['dashboard', 'community', 'developers', 'leaderboard']) {
    assert.equal(parseLichessGameId(`https://lichess.org/${route}`), null, route);
  }
});

test('colour segment gives the board perspective', () => {
  assert.equal(parseLichessFlip('https://lichess.org/CZmytj0X/black'), true);
  assert.equal(parseLichessFlip('https://lichess.org/CZmytj0X/white'), false);
  assert.equal(parseLichessFlip('https://lichess.org/CZmytj0X'), null);
});

test('pasted URLs must belong to Lichess, while paths and player tokens remain supported', () => {
  for (const value of ['https://example.com/game/CZmytj0X', 'https://lichess.org.example.com/CZmytj0X',
    '//example.com/CZmytj0X', 'ftp://lichess.org/CZmytj0X']) {
    assert.equal(parseLichessGameId(value), null, value);
  }
  for (const value of ['/game/CZmytj0XNUnq', 'https://www.lichess.org/game/CZmytj0X', 'CZmytj0X']) {
    assert.equal(parseLichessGameId(value)?.id, 'CZmytj0X', value);
  }
});
