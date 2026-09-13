// tests/bot.mjs — menguji shared/uno-bot.js
import {
    initializeGame, playCard, playerDrawsCard, isValidPlay, UNO_COLORS, hasWon
} from '../shared/uno-logic.js';
import { chooseBotAction, randomBotIdentity, BOT_NAMES, BOT_AVATARS } from '../shared/uno-bot.js';

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('pass:', m); };

// 1. Identitas bot
const ids = new Set();
for (let i = 0; i < 60; i++) {
    const idn = randomBotIdentity();
    ids.add(idn.avatar);
    if (!BOT_NAMES.includes(idn.name)) { ok(false, 'nama bot harus dari daftar'); break; }
    if (!BOT_AVATARS.includes(idn.avatar)) { ok(false, 'avatar bot harus dari daftar'); break; }
}
ok(ids.size > 1, `identitas bot bervariasi (${ids.size} avatar berbeda dari 60 kali)`);
const taken = BOT_NAMES.slice(0, BOT_NAMES.length - 1);
ok(!taken.includes(randomBotIdentity(Math.random, taken).name), 'nama bot tidak duplikat bila masih tersedia');

// 2. Bot mengambil kartu kalau tidak ada yang bisa dimainkan
{
    const g = initializeGame(2);
    g.players[0] = [{ color: 'RED', type: '5' }];
    g.currentColor = 'BLUE';
    g.lastPlayedCard = { color: 'BLUE', type: '9' };
    ok(chooseBotAction(g, 0).kind === 'draw', 'tidak ada kartu valid -> bot draw');
}

// 3. Bot memainkan kartu valid, dan tidak membuang Wild selama ada kartu normal
{
    const g = initializeGame(2);
    g.players[0] = [
        { color: 'RED', type: '5' },
        { color: 'WILD', type: 'WILD' },
        { color: 'WILD', type: 'WILD_DRAW_FOUR' }
    ];
    g.currentColor = 'RED';
    g.lastPlayedCard = { color: 'RED', type: '2' };
    const a = chooseBotAction(g, 0);
    ok(a.kind === 'play', 'bot memainkan kartu saat ada pilihan');
    ok(a.card.color === 'RED', 'bot memilih kartu normal daripada Wild');
    ok(isValidPlay(a.card, g.lastPlayedCard, g.currentColor), 'kartu pilihan bot valid');
}

// 4. Bot memakai Wild hanya sebagai jalan terakhir, dengan warna yang sah
{
    const g = initializeGame(2);
    g.players[0] = [
        { color: 'RED', type: '5' },
        { color: 'GREEN', type: 'GREEN' && '7' },
        { color: 'WILD', type: 'WILD' }
    ];
    g.players[0][1] = { color: 'GREEN', type: '7' };
    g.currentColor = 'BLUE';
    g.lastPlayedCard = { color: 'BLUE', type: '3' };
    const a = chooseBotAction(g, 0);
    ok(a.kind === 'play' && a.card.color === 'WILD', 'hanya Wild yang cocok -> bot pakai Wild');
    ok(UNO_COLORS.includes(a.chosenColor), `warna pilihan bot sah (${a.chosenColor})`);
}

// 5. Bot memilih warna yang paling banyak dipegang
{
    const g = initializeGame(2);
    g.players[0] = [
        { color: 'WILD', type: 'WILD' },
        { color: 'GREEN', type: '1' }, { color: 'GREEN', type: '2' }, { color: 'GREEN', type: '3' }
    ];
    g.currentColor = 'RED';
    g.lastPlayedCard = { color: 'RED', type: '9' };
    const a = chooseBotAction(g, 0);
    ok(a.chosenColor === 'GREEN', `bot memilih warna mayoritas (${a.chosenColor})`);
}

// 6. Bot tidak pernah memilih kartu yang tidak ada di tangan
{
    let bad = 0;
    for (let t = 0; t < 400; t++) {
        const g = initializeGame(4);
        const i = g.currentPlayerIndex;
        const a = chooseBotAction(g, i);
        if (a.kind !== 'play') continue;
        const inHand = g.players[i].some(c => c.color === a.card.color && c.type === a.card.type);
        if (!inHand || !isValidPlay(a.card, g.lastPlayedCard, g.currentColor)) bad++;
    }
    ok(bad === 0, `400 percobaan: bot selalu memilih kartu miliknya & valid (pelanggaran: ${bad})`);
}

// 7. Game penuh 4 bot sampai selesai
let finished = 0, turnsTotal = 0;
for (let t = 0; t < 40; t++) {
    const g = initializeGame(4);
    let turns = 0;
    while (g.winner === null && turns < 4000) {
        const i = g.currentPlayerIndex;
        const a = chooseBotAction(g, i);
        if (a.kind === 'play') {
            if (!playCard(g, i, a.card, a.chosenColor)) {
                ok(false, 'bot memilih langkah yang ditolak playCard');
                break;
            }
            if (hasWon(g, i)) g.winner = i;
        } else {
            playerDrawsCard(g, i, true);
        }
        turns++;
    }
    if (g.winner !== null) finished++;
    turnsTotal += turns;
}
ok(finished === 40, `40 game bot selesai semua (${finished})`);
ok(turnsTotal / 40 < 400, `bot tidak berputar-putar (rata-rata ${Math.round(turnsTotal / 40)} langkah/game)`);

console.log(fail === 0 ? '\n=== TES BOT: SEMUA LULUS ===' : `\n=== TES BOT: ${fail} GAGAL ===`);
process.exit(fail ? 1 : 0);
