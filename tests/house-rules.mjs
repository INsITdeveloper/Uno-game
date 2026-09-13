// tests/house-rules.mjs — menguji aturan rumahan:
//   multiPlay : beberapa kartu sejenis boleh keluar sekaligus
//   stacking  : +2/+4 bisa ditumpuk untuk memindahkan hukuman
import {
    initializeGame, playCard, playCards, validatePlaySet,
    playerDrawsCard, resolvePendingDraw, hasWon, UNO_COLORS
} from '../shared/uno-logic.js';
import { chooseBotAction } from '../shared/uno-bot.js';

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('pass:', m); };

/** Meja siap uji: kartu teratas RED 5, giliran pemain 0, tangan dikosongkan. */
function setup(numPlayers, rules) {
    const g = initializeGame(numPlayers, rules);
    g.players = Array.from({ length: numPlayers }, () => []);
    g.currentPlayerIndex = 0;
    g.direction = 1;
    g.pendingDraw = 0;
    g.discardPile = [{ color: 'RED', type: '5' }];
    g.lastPlayedCard = { color: 'RED', type: '5' };
    g.currentColor = 'RED';
    return g;
}

// ===========================================================================
console.log('--- 1. Default: aturan mati, perilaku sama seperti sebelumnya ---');
{
    const g = setup(2, {});
    g.players[0] = [{ color: 'BLUE', type: '5' }, { color: 'GREEN', type: '5' }];
    ok(playCards(g, 0, [{ color: 'BLUE', type: '5' }, { color: 'GREEN', type: '5' }]) === null,
        'multiPlay mati -> keluar 2 kartu sekaligus ditolak');
    ok(g.players[0].length === 2, '  -> tidak ada kartu yang terbuang');
    ok(playCard(g, 0, { color: 'BLUE', type: '5' }) !== null, 'satu kartu tetap boleh');
}
{
    const g = setup(4, {});
    g.players[0] = [{ color: 'RED', type: 'DRAW_TWO' }];
    playCards(g, 0, [{ color: 'RED', type: 'DRAW_TWO' }]);
    ok(g.players[1].length === 2, 'stacking mati -> korban langsung ambil 2');
    ok(g.pendingDraw === 0, '  -> hukuman tidak menggantung');
    ok(g.currentPlayerIndex === 2, '  -> korban dilewati');
}

// ===========================================================================
console.log('\n--- 2. Angka/simbol sama boleh keluar bersamaan ---');
{
    const g = setup(2, { multiPlay: true });
    g.players[0] = [{ color: 'BLUE', type: '5' }, { color: 'GREEN', type: '5' }, { color: 'RED', type: '7' }];
    const r = playCards(g, 0, [{ color: 'BLUE', type: '5' }, { color: 'GREEN', type: '5' }]);
    ok(r !== null, 'angka sama beda warna boleh keluar bareng');
    ok(g.discardPile.length === 3, '  -> kedua kartu masuk tumpukan buangan');
    ok(g.players[0].length === 1, '  -> keduanya keluar dari tangan');
    ok(g.currentColor === 'GREEN', `  -> warna aktif = warna kartu terakhir (${g.currentColor})`);
    ok(g.lastPlayedSet && g.lastPlayedSet.length === 2, '  -> set terakhir tercatat 2 kartu');
}
{
    const g = setup(2, { multiPlay: true });
    g.players[0] = [{ color: 'RED', type: '5' }, { color: 'RED', type: '7' }];
    ok(playCards(g, 0, [{ color: 'RED', type: '5' }, { color: 'RED', type: '7' }]) === null,
        'beda angka ditolak walau dua-duanya cocok warna');
}
{
    const g = setup(2, { multiPlay: true });
    g.players[0] = [{ color: 'BLUE', type: '5' }, { color: 'WILD', type: 'WILD' }];
    ok(validatePlaySet(g, 0, [{ color: 'BLUE', type: '5' }, { color: 'WILD', type: 'WILD' }]) !== null,
        'kartu Wild tidak boleh ikut keluar bersamaan');
}
{
    const g = setup(2, { multiPlay: true });
    g.players[0] = [{ color: 'BLUE', type: '5' }];
    ok(validatePlaySet(g, 0, [{ color: 'BLUE', type: '5' }, { color: 'BLUE', type: '5' }]) !== null,
        'tidak bisa keluar 2 kartu kalau cuma pegang 1 (anti-curang)');
}
{
    const g = setup(2, { multiPlay: true });
    g.players[0] = [{ color: 'BLUE', type: '5' }, { color: 'BLUE', type: '5' }];
    ok(playCards(g, 0, [{ color: 'BLUE', type: '5' }, { color: 'BLUE', type: '5' }]) !== null,
        'dua kartu kembar persis tetap boleh');
    ok(g.players[0].length === 0, '  -> keduanya benar-benar terpakai');
}

// ===========================================================================
console.log('\n--- 2b. Skenario dari laporan pemakaian ---');
{
    // Meja RED 6. Tangan punya RED 3 dan GREEN 3 (angka sama, beda warna).
    // GREEN 3 tidak cocok warna meja, tapi harus tetap boleh ikut keluar bareng.
    const g = setup(2, { multiPlay: true });
    g.discardPile = [{ color: 'RED', type: '6' }];
    g.lastPlayedCard = { color: 'RED', type: '6' };
    g.currentColor = 'RED';
    g.players[0] = [{ color: 'RED', type: '3' }, { color: 'GREEN', type: '3' }];

    ok(validatePlaySet(g, 0, [{ color: 'GREEN', type: '3' }, { color: 'RED', type: '3' }]) !== null,
        'GREEN 3 ditaruh paling depan -> ditolak (memang tidak cocok meja)');
    ok(validatePlaySet(g, 0, [{ color: 'RED', type: '3' }, { color: 'GREEN', type: '3' }]) === null,
        'RED 3 + GREEN 3 -> SAH walau GREEN tidak cocok warna meja');
    const r = playCards(g, 0, [{ color: 'RED', type: '3' }, { color: 'GREEN', type: '3' }]);
    ok(r !== null, '  -> benar-benar bisa dikeluarkan');
    ok(g.players[0].length === 0, '  -> kedua kartu terpakai dari tangan');
}
{
    // Kebalikannya harus DITOLAK: beda angka walau sama warna.
    const g = setup(2, { multiPlay: true });
    g.players[0] = [{ color: 'RED', type: '6' }, { color: 'RED', type: '3' }];
    ok(validatePlaySet(g, 0, [{ color: 'RED', type: '6' }, { color: 'RED', type: '3' }]) !== null,
        'RED 6 + RED 3 -> DITOLAK (beda angka) walau dua-duanya cocok warna');
}
{
    // Simbol sama, beda warna.
    const g = setup(2, { multiPlay: true });
    g.discardPile = [{ color: 'RED', type: 'SKIP' }];
    g.lastPlayedCard = { color: 'RED', type: 'SKIP' };
    g.currentColor = 'RED';
    g.players[0] = [{ color: 'BLUE', type: 'SKIP' }, { color: 'GREEN', type: 'SKIP' }];
    ok(validatePlaySet(g, 0, [{ color: 'BLUE', type: 'SKIP' }, { color: 'GREEN', type: 'SKIP' }]) === null,
        'simbol sama (SKIP) beda warna -> sah');
}

// ===========================================================================
console.log('\n--- 3. Efek kartu aksi menumpuk ---');
{
    const g = setup(4, { multiPlay: true });
    g.players[0] = [{ color: 'RED', type: 'SKIP' }, { color: 'BLUE', type: 'SKIP' }];
    playCards(g, 0, [{ color: 'RED', type: 'SKIP' }, { color: 'BLUE', type: 'SKIP' }]);
    ok(g.currentPlayerIndex === 3, `2x SKIP melewati 2 pemain (idx=${g.currentPlayerIndex}, harus 3)`);
}
{
    const g = setup(4, { multiPlay: true });
    g.players[0] = [{ color: 'RED', type: 'SKIP' }];
    playCards(g, 0, [{ color: 'RED', type: 'SKIP' }]);
    ok(g.currentPlayerIndex === 2, `1x SKIP tetap melewati 1 pemain (idx=${g.currentPlayerIndex})`);
}
{
    const g = setup(4, { multiPlay: true });   // stacking mati
    g.players[0] = [{ color: 'RED', type: 'DRAW_TWO' }, { color: 'BLUE', type: 'DRAW_TWO' }];
    playCards(g, 0, [{ color: 'RED', type: 'DRAW_TWO' }, { color: 'BLUE', type: 'DRAW_TWO' }]);
    ok(g.players[1].length === 4, `2x +2 -> korban ambil 4 (${g.players[1].length})`);
    ok(g.currentPlayerIndex === 2, '  -> korban dilewati');
}
{
    const g = setup(2, { multiPlay: true });
    g.players[0] = [{ color: 'RED', type: 'REVERSE' }, { color: 'BLUE', type: 'REVERSE' }];
    playCards(g, 0, [{ color: 'RED', type: 'REVERSE' }, { color: 'BLUE', type: 'REVERSE' }]);
    ok(g.direction === 1, '2x REVERSE membalik arah dua kali = kembali semula');
}

// ===========================================================================
console.log('\n--- 4. Menumpuk +2/+4 ---');
{
    const g = setup(2, { stacking: true });
    g.players[0] = [{ color: 'RED', type: 'DRAW_TWO' }];
    g.players[1] = [{ color: 'GREEN', type: 'DRAW_TWO' }];
    const korbanSebelum = g.players[1].length;   // 1 kartu: cukup untuk menumpuk

    playCards(g, 0, [{ color: 'RED', type: 'DRAW_TWO' }]);
    ok(g.pendingDraw === 2, 'P0 main +2 -> hukuman 2 menggantung');
    ok(g.currentPlayerIndex === 1, '  -> giliran pindah, hukuman belum diambil');
    ok(g.players[1].length === korbanSebelum, '  -> korban belum ambil kartu apa pun');

    const r = playCards(g, 1, [{ color: 'GREEN', type: 'DRAW_TWO' }]);
    ok(r !== null, 'korban boleh menumpuk +2 walau warnanya beda dari warna aktif');
    ok(g.pendingDraw === 4, `  -> hukuman jadi ${g.pendingDraw}`);
    ok(g.currentPlayerIndex === 0, '  -> hukuman balik ke P0');

    resolvePendingDraw(g, 0);
    ok(g.players[0].length === 4, `P0 menyerah -> ambil 4 kartu (${g.players[0].length})`);
    ok(g.pendingDraw === 0, '  -> hukuman selesai');
    ok(g.currentPlayerIndex === 1, '  -> giliran lanjut ke P1');
}
{
    const g = setup(2, { stacking: true });
    g.players[0] = [{ color: 'RED', type: 'DRAW_TWO' }];
    g.players[1] = [{ color: 'RED', type: '7' }];
    playCards(g, 0, [{ color: 'RED', type: 'DRAW_TWO' }]);
    ok(validatePlaySet(g, 1, [{ color: 'RED', type: '7' }]) !== null,
        'saat ada hukuman, kartu biasa ditolak');
    ok(validatePlaySet(g, 1, [{ color: 'RED', type: '7' }]).includes('Tumpuk'),
        '  -> pesan errornya menjelaskan cara menumpuk');
}
{
    const g = setup(2, { stacking: true });
    g.players[0] = [{ color: 'RED', type: 'WILD_DRAW_FOUR' }];
    g.players[1] = [{ color: 'GREEN', type: 'DRAW_TWO' }];
    playCards(g, 0, [{ color: 'RED', type: 'WILD_DRAW_FOUR' }], 'BLUE');
    ok(g.pendingDraw === 4, '+4 -> hukuman 4');
    ok(playCards(g, 1, [{ color: 'GREEN', type: 'DRAW_TWO' }]) !== null, '+2 boleh menumpuk di atas +4');
    ok(g.pendingDraw === 6, `  -> hukuman jadi ${g.pendingDraw}`);
}

// ===========================================================================
console.log('\n--- 5. Bot paham aturan baru ---');
{
    const g = setup(2, { stacking: true });
    g.players[0] = [{ color: 'RED', type: 'DRAW_TWO' }];
    g.players[1] = [{ color: 'GREEN', type: 'DRAW_TWO' }, { color: 'RED', type: '7' }];
    playCards(g, 0, [{ color: 'RED', type: 'DRAW_TWO' }]);
    const a = chooseBotAction(g, 1);
    ok(a.kind === 'play' && a.card.type === 'DRAW_TWO', 'bot menumpuk +2 saat ada hukuman');
}
{
    const g = setup(2, { stacking: true });
    g.players[0] = [{ color: 'RED', type: 'DRAW_TWO' }];
    g.players[1] = [{ color: 'RED', type: '7' }, { color: 'RED', type: '9' }];
    playCards(g, 0, [{ color: 'RED', type: 'DRAW_TWO' }]);
    ok(chooseBotAction(g, 1).kind === 'draw', 'bot menyerah kalau tidak punya +2/+4');
}

// ===========================================================================
console.log('\n--- 6. Simulasi penuh dengan aturan menyala ---');
let finished = 0, totalTurns = 0;
for (const rules of [{ multiPlay: true, stacking: true }, { multiPlay: true }, { stacking: true }]) {
    for (let t = 0; t < 15; t++) {
        const g = initializeGame(4, rules);
        let turns = 0;
        while (g.winner === null && turns < 5000) {
            const i = g.currentPlayerIndex;
            const a = chooseBotAction(g, i);
            if (a.kind === 'play') {
                if (!playCard(g, i, a.card, a.chosenColor)) {
                    console.log('FAIL: bot memilih langkah yang ditolak aturan');
                    fail++; break;
                }
                if (hasWon(g, i)) g.winner = i;
            } else if (g.pendingDraw > 0) {
                resolvePendingDraw(g, i);
            } else {
                playerDrawsCard(g, i, true);
            }
            if (g.pendingDraw < 0) { console.log('FAIL: pendingDraw negatif'); fail++; break; }
            turns++;
        }
        if (g.winner !== null) finished++;
        totalTurns += turns;
    }
}
ok(finished === 45, `45 game dengan aturan menyala selesai semua (${finished})`);
ok(totalTurns / 45 < 900, `tidak ada kebuntuan (rata-rata ${Math.round(totalTurns / 45)} langkah/game)`);

console.log(fail === 0 ? '\n=== ATURAN RUMAHAN: SEMUA LULUS ===' : `\n=== ATURAN RUMAHAN: ${fail} GAGAL ===`);
process.exit(fail ? 1 : 0);
