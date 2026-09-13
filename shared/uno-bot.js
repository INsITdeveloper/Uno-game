// shared/uno-bot.js
// Kecerdasan buatan untuk lawan bot.
// Murni fungsi tanpa efek samping supaya mudah diuji dan dijalankan di server.

import { isValidPlay, UNO_COLORS, UNO_ACTION_CARDS } from './uno-logic.js';

export const BOT_NAMES = [
    'Bot Andi', 'Bot Sari', 'Bot Budi', 'Bot Rina', 'Bot Joko',
    'Bot Maya', 'Bot Tono', 'Bot Lia', 'Bot Dewi', 'Bot Eko'
];

export const BOT_AVATARS = [
    'a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07',
    'a08', 'a09', 'a10', 'a11', 'a12', 'a13', 'a14'
];

/**
 * Identitas bot acak. `rand` bisa diganti untuk pengujian deterministik.
 * @param {() => number} rand
 * @param {string[]} [takenNames] nama yang sudah dipakai di room
 */
export function randomBotIdentity(rand = Math.random, takenNames = []) {
    const free = BOT_NAMES.filter((n) => !takenNames.includes(n));
    const pool = free.length ? free : BOT_NAMES;
    return {
        name: pool[Math.floor(rand() * pool.length)],
        avatar: BOT_AVATARS[Math.floor(rand() * BOT_AVATARS.length)]
    };
}

/**
 * Warna yang paling banyak dipegang bot (untuk kartu Wild).
 */
function mostCommonColor(hand, rand = Math.random) {
    const tally = {};
    for (const card of hand) {
        if (card.color !== 'WILD') tally[card.color] = (tally[card.color] || 0) + 1;
    }
    let best = UNO_COLORS[Math.floor(rand() * UNO_COLORS.length)];
    let bestCount = -1;
    for (const color of UNO_COLORS) {
        const count = tally[color] || 0;
        if (count > bestCount) {
            bestCount = count;
            best = color;
        }
    }
    return best;
}

function pick(list, rand) {
    return list[Math.floor(rand() * list.length)];
}

/**
 * Menentukan langkah bot pada gilirannya.
 *
 * Strategi:
 *  1. Kalau ada kartu yang bisa dimainkan, mainkan (tidak pernah menyerah).
 *  2. Utamakan kartu berwarna sama dengan warna aktif supaya warna tetap menguntungkan.
 *  3. Simpan kartu Wild selama masih ada kartu normal.
 *  4. Pakai kartu serang (SKIP/REVERSE/+2) saat tangan sendiri sedikit atau lawan hampir habis.
 *  5. Kalau tidak ada yang bisa dimainkan, ambil kartu.
 *
 * @param {object} game state dari uno-logic
 * @param {number} playerIndex
 * @param {() => number} [rand]
 * @returns {{kind:'play', card:{color:string,type:string}, chosenColor:string|null} | {kind:'draw'}}
 */
export function chooseBotAction(game, playerIndex, rand = Math.random) {
    const hand = game.players[playerIndex] || [];
    const playable = hand.filter((c) => isValidPlay(c, game.lastPlayedCard, game.currentColor));

    if (playable.length === 0) {
        return { kind: 'draw' };
    }

    const isNumber = (c) => /^[0-9]$/.test(c.type);
    const numbers = playable.filter(isNumber);
    const actions = playable.filter((c) => UNO_ACTION_CARDS.includes(c.type));
    const wilds = playable.filter((c) => c.color === 'WILD');

    // Seberapa dekat lawan terdekat dengan kemenangan
    let opponentMin = Infinity;
    game.players.forEach((h, i) => {
        if (i !== playerIndex && h.length < opponentMin) opponentMin = h.length;
    });

    const nonWild = numbers.concat(actions);
    if (nonWild.length > 0) {
        // Serang kalau kita sudah dekat menang atau lawan hampir habis
        const preferAction = (hand.length <= 3 || opponentMin <= 2) && actions.length > 0;
        let pool = preferAction ? actions : (numbers.length ? numbers : actions);

        // Prioritaskan warna aktif agar pilihan tetap terbuka untuk giliran berikutnya
        const sameColor = pool.filter((c) => c.color === game.currentColor);
        const choice = pick(sameColor.length ? sameColor : pool, rand);

        return {
            kind: 'play',
            card: { color: choice.color, type: choice.type },
            chosenColor: null
        };
    }

    // Hanya punya Wild: simpan +4 untuk momen penting, sisanya pakai Wild biasa
    const useDrawFour = hand.length <= 3 || opponentMin <= 2;
    const preferred = wilds.filter((c) => (c.type === 'WILD_DRAW_FOUR') === useDrawFour);
    const choice = pick(preferred.length ? preferred : wilds, rand);

    return {
        kind: 'play',
        card: { color: 'WILD', type: choice.type },
        chosenColor: mostCommonColor(hand, rand)
    };
}
