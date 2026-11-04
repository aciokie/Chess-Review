// The Recent-games username field remembers the names it has actually fetched, per site, so a
// different player is one click instead of typing. popup.js had no coverage at all before this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { popup, game } from './helpers/popup.mjs';

test('the username field is shaped so the browser can autofill and Enter can submit', async t => {
  const p = await popup(t);
  const input = p.$('recentUser');
  // A browser only offers autofill for a field it can identify, inside a form it can submit.
  assert.equal(input.closest('form')?.id, 'recentForm', 'the field must be inside a form');
  assert.equal(input.getAttribute('name'), 'username', 'a named field is what autofill keys on');
  assert.equal(input.getAttribute('autocomplete'), 'username');
  assert.equal(input.getAttribute('list'), 'recentUserList', "and it carries this extension's own list");
  assert.equal(p.$('fetchRecent').type, 'submit', 'Fetch must submit the form, not just click');
  assert.equal(p.$('fetchRecent').closest('form').id, 'recentForm');
});

test('a name that fetched games is remembered and offered again', async t => {
  const p = await popup(t);
  assert.deepEqual(p.chips(), [], 'nothing is offered before the first fetch');
  assert.deepEqual(p.options(), []);

  await p.pickUser('Hikaru');

  assert.deepEqual(p.store['recentUsers:lichess'], ['Hikaru'], 'the name is stored for the site');
  assert.equal(p.store['recentUser:lichess'], 'Hikaru', 'and as the site’s last-used name');
  assert.deepEqual(p.chips(), ['Hikaru'], 'it is offered as a chip');
  assert.deepEqual(p.options(), ['Hikaru'], 'and in the field’s suggestion list');
  assert.deepEqual(p.calls.fetches, [{ user: 'Hikaru', site: 'lichess' }]);
});

test('different players accumulate newest first, deduped and capped', async t => {
  const p = await popup(t);
  for (const name of ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j10']) await p.pickUser(name);

  const saved = p.store['recentUsers:lichess'];
  assert.equal(saved.length, 8, 'only the most recent 8 are kept');
  assert.equal(saved[0], 'j10', 'the newest name leads');
  assert.deepEqual(saved, ['j10', 'i9', 'h8', 'g7', 'f6', 'e5', 'd4', 'c3']);
  assert.deepEqual(p.options(), saved, 'the suggestion list matches');

  // The same player again moves to the front instead of appearing twice, whatever the casing.
  await p.pickUser('B2');
  assert.deepEqual(p.store['recentUsers:lichess'].slice(0, 2), ['B2', 'j10'], 'the newest spelling wins');
  assert.equal(p.store['recentUsers:lichess'].filter(n => n.toLowerCase() === 'b2').length, 1);
});

test('a fetch that fails is never offered back', async t => {
  const p = await popup(t, { pager: () => ({ error: 'No Lichess user called “zzz”.' }) });
  await p.pickUser('zzz');
  assert.equal(p.store['recentUsers:lichess'], undefined, 'a typo must not be remembered');
  assert.deepEqual(p.chips(), []);
  assert.match(p.$('recentStatus').textContent, /No Lichess user/);

  // A name that works later is remembered as normal.
  await p.pickUser('ana');
  assert.equal(p.store['recentUsers:lichess'], undefined, 'the failed pager still fails');
});

test('each site keeps its own names and the field follows the site', async t => {
  const p = await popup(t, {
    storage: { username: 'shared-handle', 'recentUser:lichess': 'ana', 'recentUsers:lichess': ['ana', 'bob'] },
  });
  assert.equal(p.$('recentUser').value, 'ana', 'Lichess opens with its own last name');
  assert.deepEqual(p.options(), ['ana', 'bob']);

  await p.chooseSite('chesscom', 1);
  assert.equal(p.$('recentUser').value, 'shared-handle', 'Chess.com falls back to the shared handle');
  assert.deepEqual(p.options(), ['shared-handle'], 'and offers it, with no Lichess names mixed in');
  assert.equal(p.store.recentSite, 'chesscom');

  await p.pickUser('Magnus');
  assert.deepEqual(p.store['recentUsers:chesscom'], ['Magnus']);
  assert.deepEqual(p.store['recentUsers:lichess'], ['ana', 'bob'], 'the other site is untouched');

  await p.chooseSite('lichess', 0);
  assert.equal(p.$('recentUser').value, 'ana');
  assert.deepEqual(p.chips(), ['ana', 'bob']);
});

test('clicking a chip fetches that player without typing', async t => {
  const p = await popup(t, { storage: { 'recentUsers:lichess': ['ana', 'bob', 'cid'] } });
  assert.deepEqual(p.chips(), ['ana', 'bob', 'cid']);

  p.$('recentSaved').querySelectorAll('button')[2].click();
  await p.settle();
  assert.equal(p.$('recentUser').value, 'cid', 'the field follows the chip');
  assert.deepEqual(p.calls.fetches, [{ user: 'cid', site: 'lichess' }], 'and the fetch is that player');
  assert.equal(p.document.querySelectorAll('#recentList .recent-row').length, 1, 'their games are listed');

  // Chips are inside the Recent section, not the form: they must never submit it.
  assert.equal(p.$('recentSaved').closest('form'), null);
});

test('Enter in the field fetches the typed name and never navigates', async t => {
  const p = await popup(t);
  p.$('recentUser').value = 'Zhigalko';
  const { prevented } = p.submit();
  await p.settle();
  assert.equal(prevented, true, 'the submit is cancelled, so the popup does not navigate');
  assert.deepEqual(p.calls.fetches, [{ user: 'Zhigalko', site: 'lichess' }]);
  assert.equal(p.$('recentUser').value, 'Zhigalko', 'the typed name stays in the field');
});

test('a remembered name leads the offers even without the list (older installs)', async t => {
  const p = await popup(t, { storage: { 'recentUser:lichess': 'Legacy' } });
  assert.equal(p.$('recentUser').value, 'Legacy', 'the pre-list save still fills the field');
  assert.deepEqual(p.options(), ['Legacy'], 'and is offered rather than lost');
  await p.pickUser('Newer');
  assert.deepEqual(p.store['recentUsers:lichess'], ['Newer', 'Legacy']);
});

test('a listed game opens the review with that viewer', async t => {
  const p = await popup(t, { pager: { games: [game()] } });
  await p.pickUser('ana');
  p.document.querySelector('#recentList .recent-row').click();
  await p.settle();
  assert.equal(p.calls.opened.length, 1, 'the row hands the game to the review');
  assert.equal(p.calls.opened[0].source, 'recent-lichess');
  assert.equal(p.calls.opened[0].meta.myName, 'ana', 'the viewer is the name that was fetched');
  assert.equal(p.calls.closed, 1, 'and the popup closes behind it');
});
