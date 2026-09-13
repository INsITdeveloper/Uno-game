// shared/uno-logic.js
// Logika inti permainan Uno.
// File ini adalah SUMBER KEBENARAN dan hanya boleh dijalankan di server.
// Klien tidak mengimpor file ini (klien punya salinan sederhana hanya untuk highlight kartu).

export const UNO_COLORS = ['RED', 'YELLOW', 'GREEN', 'BLUE'];
export const UNO_NUMBERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
export const UNO_ACTION_CARDS = ['SKIP', 'REVERSE', 'DRAW_TWO'];
export const UNO_WILD_CARDS = ['WILD', 'WILD_DRAW_FOUR'];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const HAND_SIZE = 7;

/**
 * Membuat satu set dek kartu Uno standar (108 kartu).
 * @returns {Array<{color: string, type: string}>}
 */
export function createDeck() {
    const deck = [];

    // Kartu angka: satu '0' dan dua '1'-'9' per warna => 76 kartu
    UNO_COLORS.forEach((color) => {
        deck.push({ color, type: '0' });
        for (let i = 1; i <= 9; i++) {
            const value = i.toString();
            deck.push({ color, type: value });
            deck.push({ color, type: value });
        }
    });

    // Kartu aksi berwarna: dua per jenis per warna => 24 kartu
    UNO_COLORS.forEach((color) => {
        UNO_ACTION_CARDS.forEach((type) => {
            deck.push({ color, type });
            deck.push({ color, type });
        });
    });

    // Wild & Wild Draw Four: empat masing-masing => 8 kartu
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'WILD', type: 'WILD' });
        deck.push({ color: 'WILD', type: 'WILD_DRAW_FOUR' });
    }

    return deck;
}

/**
 * Fisher-Yates shuffle. Mengocok in-place dan mengembalikan array yang sama.
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffleDeck(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Inisialisasi state game baru.
 * @param {number} numPlayers
 * @returns {object|null} state game, atau null bila jumlah pemain tidak valid / dek tidak memadai.
 */
/** Aturan rumahan yang bisa dinyalakan pembuat room. */
export const DEFAULT_RULES = { multiPlay: false, stacking: false };

/** Kartu yang boleh menumpuk di atas hukuman yang menggantung. */
export const STACKABLE_TYPES = ['DRAW_TWO', 'WILD_DRAW_FOUR'];

/**
 * @param {number} numPlayers
 * @param {{multiPlay?: boolean, stacking?: boolean}} [rules]
 *   multiPlay: beberapa kartu sejenis boleh keluar sekaligus
 *   stacking : +2/+4 bisa ditumpuk untuk memindahkan hukuman
 */
export function initializeGame(numPlayers, rules = {}) {
    if (!Number.isInteger(numPlayers) || numPlayers < MIN_PLAYERS || numPlayers > MAX_PLAYERS) {
        console.error(`Jumlah pemain harus antara ${MIN_PLAYERS} dan ${MAX_PLAYERS}. Diterima: ${numPlayers}`);
        return null;
    }

    let deck = shuffleDeck(createDeck());

    // Bagikan HAND_SIZE kartu ke setiap pemain
    const players = Array.from({ length: numPlayers }, () => []);
    for (let round = 0; round < HAND_SIZE; round++) {
        for (let p = 0; p < numPlayers; p++) {
            const card = deck.pop();
            if (!card) {
                console.error('Dek habis saat membagikan kartu.');
                return null;
            }
            players[p].push(card);
        }
    }

    // Cari kartu angka untuk membuka discard pile (tanpa loop tak terbatas).
    let firstCard = null;
    const rejected = [];
    while (deck.length > 0) {
        const candidate = deck.pop();
        if (UNO_NUMBERS.includes(candidate.type)) {
            firstCard = candidate;
            break;
        }
        rejected.push(candidate);
    }

    if (!firstCard) {
        console.error('Tidak dapat menemukan kartu angka untuk memulai permainan.');
        return null;
    }

    // Sisa kartu non-angka dikembalikan ke dek lalu dikocok ulang.
    deck.push(...rejected);
    deck = shuffleDeck(deck);

    return {
        deck,
        discardPile: [firstCard],
        players,
        currentPlayerIndex: 0,
        direction: 1, // 1 = searah jarum jam, -1 = berlawanan
        lastPlayedCard: firstCard,
        currentColor: firstCard.color,
        pendingDraw: 0,
        messages: [],
        winner: null,       // index pemain pemenang, atau null
        lastDrawnCard: null, // hanya dipakai untuk pesan internal server
        rules: {
            multiPlay: Boolean(rules.multiPlay),
            stacking: Boolean(rules.stacking)
        }
    };
}

/**
 * Apakah kartu boleh dimainkan?
 * @param {{color:string,type:string}} cardToPlay
 * @param {{color:string,type:string}} lastPlayedCard
 * @param {string} currentColor
 * @returns {boolean}
 */
export function isValidPlay(cardToPlay, lastPlayedCard, currentColor) {
    if (!cardToPlay || typeof cardToPlay !== 'object') return false;

    // Wild selalu bisa dimainkan
    if (cardToPlay.color === 'WILD') return true;

    // Warna cocok dengan warna aktif
    if (cardToPlay.color === currentColor) return true;

    // Tipe cocok dengan kartu teratas (mis. RED SKIP vs BLUE SKIP)
    if (lastPlayedCard && cardToPlay.type === lastPlayedCard.type) return true;

    return false;
}

/**
 * Memainkan kartu. Semua validasi dilakukan di sini.
 * @param {object} gameState
 * @param {number} playerIndex
 * @param {{color:string,type:string}} cardToPlay
 * @param {string|null} chosenColor - wajib untuk kartu WILD.
 * @returns {object|null} gameState bila berhasil, null bila tidak valid.
 */
/**
 * Periksa satu set kartu yang mau dimainkan bersamaan.
 * @returns {string|null} pesan alasan kalau ditolak, atau null kalau sah.
 */
export function validatePlaySet(gameState, playerIndex, cards, chosenColor = null) {
    if (!gameState || gameState.winner !== null) return 'Permainan sudah selesai.';
    if (!Array.isArray(cards) || cards.length === 0) return 'Tidak ada kartu yang dimainkan.';

    const hand = gameState.players[playerIndex];
    if (!hand) return 'Pemain tidak dikenal.';

    const multiPlay = Boolean(gameState.rules && gameState.rules.multiPlay);
    if (cards.length > 1 && !multiPlay) {
        return 'Aturan keluar beberapa kartu sedang mati di room ini.';
    }

    const key = (c) => `${c.color}|${c.type}`;

    // Anti-curang: tiap kartu harus benar-benar ada di tangan, sehitung jumlahnya
    const need = new Map();
    for (const c of cards) {
        if (!c || typeof c.color !== 'string' || typeof c.type !== 'string') return 'Data kartu tidak valid.';
        need.set(key(c), (need.get(key(c)) || 0) + 1);
    }
    const have = new Map();
    for (const c of hand) have.set(key(c), (have.get(key(c)) || 0) + 1);
    for (const [k, n] of need) {
        if ((have.get(k) || 0) < n) return 'Ada kartu yang tidak Anda pegang.';
    }

    const first = cards[0];

    // Kalau keluar beberapa sekaligus: harus sejenis, dan Wild tidak boleh ikut
    if (cards.length > 1) {
        if (first.color === 'WILD') return 'Kartu Wild tidak bisa dimainkan sekaligus.';
        for (const c of cards.slice(1)) {
            if (c.color === 'WILD') return 'Kartu Wild tidak bisa dimainkan sekaligus.';
            if (c.type !== first.type) return 'Kartu yang keluar bersamaan harus sama angka atau simbolnya.';
        }
    }

    if (first.color === 'WILD' && !UNO_COLORS.includes(chosenColor)) {
        return 'Kartu Wild butuh pilihan warna.';
    }

    // Ada hukuman menggantung: satu-satunya jalan adalah menumpuk +2/+4.
    // Menumpuk sengaja TIDAK perlu cocok warna — itu inti aturan ini.
    if (gameState.pendingDraw > 0) {
        if (!STACKABLE_TYPES.includes(first.type)) {
            return `Ada hukuman ${gameState.pendingDraw} kartu. Tumpuk +2/+4, atau ambil kartunya.`;
        }
        return null;
    }

    if (!isValidPlay(first, gameState.lastPlayedCard, gameState.currentColor)) {
        return 'Kartu pertama tidak cocok dengan meja.';
    }

    return null;
}

/**
 * Memainkan satu atau beberapa kartu sekaligus.
 * @returns {object|null} gameState bila berhasil, null bila tidak sah.
 */
export function playCards(gameState, playerIndex, cards, chosenColor = null) {
    if (!gameState || gameState.winner !== null) return null;

    const problem = validatePlaySet(gameState, playerIndex, cards, chosenColor);
    if (problem) {
        console.warn(problem);
        return null;
    }

    const hand = gameState.players[playerIndex];
    const isWild = cards[0].color === 'WILD';

    // Buang tiap kartu dari tangan lalu taruh ke tumpukan buangan
    const placed = [];
    for (const c of cards) {
        const idx = hand.findIndex((h) => h.color === c.color && h.type === c.type);
        if (idx === -1) return null;
        hand.splice(idx, 1);

        const cardOnPile = { color: c.color, type: c.type };
        if (isWild) cardOnPile.chosenColor = chosenColor;
        gameState.discardPile.push(cardOnPile);
        placed.push(cardOnPile);
    }

    gameState.lastPlayedCard = placed[placed.length - 1];
    gameState.lastPlayedSet = placed;
    gameState.currentColor = isWild ? chosenColor : placed[placed.length - 1].color;

    applySetEffects(gameState, placed);

    return gameState;
}

/** Pembungkus satu kartu — dipakai tes lama dan bot. */
export function playCard(gameState, playerIndex, cardToPlay, chosenColor = null) {
    return playCards(gameState, playerIndex, [cardToPlay], chosenColor);
}

/**
 * Pemain mengambil satu kartu dari dek.
 * @param {object} gameState
 * @param {number} playerIndex
 * @param {boolean} [endTurn=false]
 * @returns {object|null}
 */
export function playerDrawsCard(gameState, playerIndex, endTurn = false) {
    if (!gameState || gameState.winner !== null) return null;

    const playerHand = gameState.players[playerIndex];
    if (!playerHand) return null;

    // Kocok ulang discard pile bila dek habis.
    if (gameState.deck.length === 0) {
        if (gameState.discardPile.length <= 1) {
            gameState.messages.push({
                type: 'warning',
                text: 'Tidak ada kartu tersisa untuk diambil.'
            });
            return null;
        }

        const topCard = gameState.discardPile.pop();
        const recyclable = gameState.discardPile.map((c) =>
            c.chosenColor ? { color: c.color, type: c.type } : { color: c.color, type: c.type }
        );
        gameState.deck = shuffleDeck(recyclable);
        gameState.discardPile = [topCard];
        gameState.messages.push({ type: 'info', text: 'Dek habis — tumpukan buangan dikocok ulang.' });
    }

    const drawnCard = gameState.deck.pop();
    playerHand.push(drawnCard);
    gameState.lastDrawnCard = drawnCard;

    gameState.messages.push({ type: 'info', text: `Pemain ${playerIndex + 1} mengambil 1 kartu.` });

    if (endTurn) {
        moveToNextPlayer(gameState);
    }

    return gameState;
}

/**
 * Menerapkan efek kartu aksi dan memindahkan giliran.
 * @param {object} gameState
 * @param {{color:string,type:string}} card
 */
export function applySetEffects(gameState, cards) {
    const type = cards[0].type;
    const n = cards.length;
    const stacking = Boolean(gameState.rules && gameState.rules.stacking);
    const banyak = n > 1 ? ` (${n} kartu)` : '';

    switch (type) {
        case 'SKIP':
            // Lewati n pemain: geser ke lawan, lalu geser lagi n kali
            for (let i = 0; i < n + 1; i++) moveToNextPlayer(gameState);
            gameState.messages.push({
                type: 'info',
                text: n > 1 ? `Giliran ${n} pemain dilewati.` : 'Giliran pemain berikutnya dilewati.'
            });
            break;

        case 'REVERSE':
            // Tiap kartu membalik arah
            for (let i = 0; i < n; i++) gameState.direction *= -1;
            if (gameState.players.length === 2) {
                // Dengan 2 pemain, REVERSE berlaku seperti SKIP
                moveToNextPlayer(gameState);
                moveToNextPlayer(gameState);
                gameState.messages.push({ type: 'info', text: `Arah berubah — giliran lawan dilewati${banyak}.` });
            } else {
                moveToNextPlayer(gameState);
                gameState.messages.push({ type: 'info', text: `Arah permainan berbalik${banyak}.` });
            }
            break;

        case 'DRAW_TWO':
        case 'WILD_DRAW_FOUR': {
            const amount = (type === 'DRAW_TWO' ? 2 : 4) * n;
            gameState.pendingDraw += amount;
            moveToNextPlayer(gameState);

            if (stacking) {
                // Hukuman menggantung: pemain berikutnya boleh menumpuk +2/+4
                // atau mengambil semuanya.
                const target = gameState.players[gameState.currentPlayerIndex];
                const bisaTumpuk = target.some((c) => STACKABLE_TYPES.includes(c.type));
                gameState.messages.push({
                    type: 'warning',
                    text: bisaTumpuk
                        ? `Hukuman ${gameState.pendingDraw} kartu untuk pemain ${gameState.currentPlayerIndex + 1} — tumpuk +2/+4 atau ambil.`
                        : `Pemain ${gameState.currentPlayerIndex + 1} harus mengambil ${gameState.pendingDraw} kartu.`
                });
                gameState.messages.push({
                    type: 'stack',
                    pending: gameState.pendingDraw,
                    to: gameState.currentPlayerIndex
                });
            } else {
                handlePendingDraw(gameState);
            }
            break;
        }

        default: // kartu angka & WILD biasa
            moveToNextPlayer(gameState);
            break;
    }
    return gameState;
}

/** Pembungkus satu kartu untuk kompatibilitas. */
export function applyCardEffect(gameState, card) {
    return applySetEffects(gameState, [card]);
}

/**
 * Pemain yang kena hukuman mengambil seluruh hukuman lalu kehilangan giliran.
 * Dipakai saat aturan menumpuk aktif dan pemain memilih mengambil.
 */
export function resolvePendingDraw(gameState, playerIndex) {
    const amount = gameState.pendingDraw;
    gameState.pendingDraw = 0;

    for (let i = 0; i < amount; i++) playerDrawsCard(gameState, playerIndex, false);

    gameState.messages.push({
        type: 'warning',
        text: `Pemain ${playerIndex + 1} mengambil ${amount} kartu.`
    });

    moveToNextPlayer(gameState);
    return gameState;
}

/**
 * Pemain yang kena efek DRAW_TWO / WILD_DRAW_FOUR mengambil kartu dan kehilangan giliran.
 * @param {object} gameState
 * @returns {object} gameState
 */
export function handlePendingDraw(gameState) {
    if (!gameState || !gameState.pendingDraw) return gameState;

    const victimIndex = gameState.currentPlayerIndex;
    const amount = gameState.pendingDraw;
    gameState.pendingDraw = 0;

    for (let i = 0; i < amount; i++) {
        playerDrawsCard(gameState, victimIndex, false);
    }

    gameState.messages.push({
        type: 'info',
        text: `Pemain ${victimIndex + 1} mengambil ${amount} kartu dan kehilangan gilirannya.`
    });

    moveToNextPlayer(gameState);
    return gameState;
}

/**
 * Pindah giliran sesuai arah permainan.
 * @param {object} gameState
 */
export function moveToNextPlayer(gameState) {
    const total = gameState.players.length;
    if (total === 0) return;

    gameState.currentPlayerIndex += gameState.direction;
    gameState.currentPlayerIndex = ((gameState.currentPlayerIndex % total) + total) % total;
}

/**
 * Apakah pemain sudah menang (tangan kosong)?
 * @param {object} gameState
 * @param {number} playerIndex
 * @returns {boolean}
 */
export function hasWon(gameState, playerIndex) {
    return Boolean(gameState && gameState.players[playerIndex] && gameState.players[playerIndex].length === 0);
}
