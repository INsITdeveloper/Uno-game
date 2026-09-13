import {
  initializeGame, playCard, playerDrawsCard, isValidPlay,
  UNO_COLORS, hasWon, MIN_PLAYERS
} from '../shared/uno-logic.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.log('FAIL:', msg); fail++; } else console.log('pass:', msg); };

// 1. Deck / init
for (const n of [2, 3, 5, 10]) {
  const g = initializeGame(n);
  ok(g !== null, `initializeGame(${n}) berhasil`);
  ok(g.players.length === n, `  -> ${n} tangan pemain`);
  ok(g.players.every(h => h.length === 7), '  -> tiap pemain 7 kartu');
  ok(g.discardPile.length === 1, '  -> 1 kartu pembuka');
  const total = g.deck.length + g.players.flat().length + g.discardPile.length;
  ok(total === 108, `  -> total kartu 108 (dapat ${total})`);
  ok(!UNO_COLORS.includes(g.discardPile[0].type) && /^[0-9]$/.test(g.discardPile[0].type), '  -> pembuka adalah kartu angka');
}
ok(initializeGame(1) === null, 'initializeGame(1) ditolak');
ok(initializeGame(11) === null, 'initializeGame(11) ditolak');

// 2. isValidPlay
const g = initializeGame(2);
ok(isValidPlay({color:'WILD',type:'WILD'}, g.lastPlayedCard, g.currentColor), 'Wild selalu valid');
ok(isValidPlay({color:g.currentColor,type:'5'}, g.lastPlayedCard, g.currentColor), 'warna sama valid');
ok(!isValidPlay({color:'WILD_FAKE',type:'NOT_A_CARD'}, g.lastPlayedCard, g.currentColor), 'warna & tipe tidak cocok -> tidak valid');

// 3. Anti-cheat: main kartu yang tidak ada di tangan
const before = g.players[0].length;
const bogus = { color: 'RED', type: '9' };
const notInHand = !g.players[0].some(c => c.color===bogus.color && c.type===bogus.type);
if (notInHand) {
  ok(playCard(g, 0, bogus, null) === null, 'kartu yang tidak ada di tangan ditolak');
  ok(g.players[0].length === before, '  -> jumlah kartu tidak berubah');
}

// 4. Wild tanpa warna -> ditolak
const wild = { color: 'WILD', type: 'WILD' };
g.players[0].push(wild);
ok(playCard(g, 0, wild, null) === null, 'Wild tanpa chosenColor ditolak');
ok(playCard(g, 0, wild, 'PURPLE') === null, 'Wild dengan warna tidak valid ditolak');
ok(g.currentColor !== 'PURPLE', 'currentColor tidak berubah jadi PURPLE');

// 5. Giliran bukan pemain 0 -> server yang memutuskan (playCard tidak cek giliran, server yang cek)
//    Simulasi langsung: paksa kartu yang valid
let game = initializeGame(4);
const p0 = game.players[0].find(c => /^[0-9]$/.test(c.type));  // kartu angka = giliran maju 1 langkah
if (p0) {
  game.currentColor = p0.color; // pastikan valid
  const nextIdx = (game.currentPlayerIndex + game.direction + game.players.length) % game.players.length;
  playCard(game, 0, {color:p0.color,type:p0.type}, null);
  ok(game.currentPlayerIndex === nextIdx, `giliran maju ke pemain ${nextIdx}`);
  ok(game.discardPile.length === 2, 'kartu masuk discard pile');
  ok(game.players[0].length === 6, 'kartu keluar dari tangan');
}

// 6. DRAW_CARD mengakhiri giliran + isi tangan bertambah
game = initializeGame(3);
const handBefore = game.players[0].length;
const idxBefore = game.currentPlayerIndex;
playerDrawsCard(game, 0, true);
ok(game.players[0].length === handBefore + 1, 'draw menambah kartu');
ok(game.currentPlayerIndex !== idxBefore, 'draw mengakhiri giliran');

// 7. Simulasi game penuh sampai ada pemenang (bot acak) -> membuktikan win condition & tidak crash
for (let trial = 0; trial < 30; trial++) {
  const G = initializeGame(4);
  let turns = 0;
  while (G.winner === null && turns < 3000) {
    const p = G.currentPlayerIndex;
    const hand = G.players[p];
    const top = G.lastPlayedCard;
    const playable = hand.filter(c => isValidPlay(c, top, G.currentColor));
    if (playable.length === 0) {
      playerDrawsCard(G, p, true);
    } else {
      const card = playable[Math.floor(Math.random()*playable.length)];
      const chosen = card.color === 'WILD' ? UNO_COLORS[Math.floor(Math.random()*4)] : null;
      const res = playCard(G, p, {color:card.color,type:card.type}, chosen);
      if (!res) { console.log('FAIL: playCard menolak kartu yang dianggap playable'); fail++; break; }
      if (hasWon(G, p)) G.winner = p;
    }
    turns++;
  }
  ok(G.winner !== null, `trial ${trial}: game selesai dengan pemenang (${turns} giliran)`);
  ok(G.players[G.winner].length === 0, `trial ${trial}: tangan pemenang kosong`);
  ok(G.deck.length >= 0 && G.discardPile.length >= 1, `trial ${trial}: dek & discard konsisten`);
}

// 8. Special cards: SKIP / REVERSE / DRAW_TWO
function forcePlay(cardType, cardColor, numPlayers) {
  const s = initializeGame(numPlayers);
  const card = { color: cardColor, type: cardType };
  s.players[0].push(card);
  s.currentColor = cardColor;
  s.lastPlayedCard = { color: cardColor, type: '5' };
  s.currentPlayerIndex = 0;
  playCard(s, 0, card, card.color === 'WILD' ? 'BLUE' : null);
  return s;
}
let s = forcePlay('SKIP', 'RED', 4);
ok(s.currentPlayerIndex === 2, `SKIP melewati 1 pemain (idx=${s.currentPlayerIndex}, harus 2)`);
s = forcePlay('REVERSE', 'RED', 4);
ok(s.direction === -1, 'REVERSE membalik arah');
ok(s.currentPlayerIndex === 3, `REVERSE dengan 4 pemain -> idx 3 (idx=${s.currentPlayerIndex})`);
s = forcePlay('REVERSE', 'RED', 2);
ok(s.currentPlayerIndex === 0, `REVERSE dengan 2 pemain = SKIP, kembali ke pemain 0 (idx=${s.currentPlayerIndex})`);
s = forcePlay('DRAW_TWO', 'RED', 4);
ok(s.players[1].length === 9, `DRAW_TWO: korban punya 9 kartu (${s.players[1].length})`);
ok(s.currentPlayerIndex === 2, `DRAW_TWO: giliran lanjut ke pemain 2 (idx=${s.currentPlayerIndex})`);
ok(s.pendingDraw === 0, 'pendingDraw direset');
s = forcePlay('WILD_DRAW_FOUR', 'WILD', 4);
ok(s.currentColor === 'BLUE', 'WILD_DRAW_FOUR menerapkan warna pilihan');
ok(s.players[1].length === 11, `WILD_DRAW_FOUR: korban punya 11 kartu (${s.players[1].length})`);
ok(s.currentPlayerIndex === 2, `WILD_DRAW_FOUR: giliran lanjut ke pemain 2 (idx=${s.currentPlayerIndex})`);

// 9. Dek habis -> reshuffle discard pile
s = initializeGame(2);
s.deck = [];
s.discardPile.push({ color: 'RED', type: '3' }, { color: 'BLUE', type: '7' });
const beforeReshuffle = s.players[0].length;
playerDrawsCard(s, 0, false);
ok(s.players[0].length === beforeReshuffle + 1, 'deck habis -> reshuffle lalu tetap bisa draw');
ok(s.discardPile.length === 1, 'discard pile tersisa 1 kartu setelah reshuffle');

console.log(fail === 0 ? '\n=== SEMUA TES LULUS ===' : `\n=== ${fail} TES GAGAL ===`);
process.exit(fail === 0 ? 0 : 1);
