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
export function initializeGame(numPlayers) {
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
        lastDrawnCard: null // hanya dipakai untuk pesan internal server
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
export function playCard(gameState, playerIndex, cardToPlay, chosenColor = null) {
    if (!gameState || gameState.winner !== null) return null;

    const playerHand = gameState.players[playerIndex];
    if (!playerHand) return null;

    const cardIndexInHand = playerHand.findIndex(
        (c) => c.color === cardToPlay.color && c.type === cardToPlay.type
    );
    if (cardIndexInHand === -1) {
        console.warn(`Pemain ${playerIndex} tidak memiliki kartu ${cardToPlay.color} ${cardToPlay.type}.`);
        return null; // Anti-cheat: kartu harus benar-benar ada di tangan
    }

    if (!isValidPlay(cardToPlay, gameState.lastPlayedCard, gameState.currentColor)) {
        console.warn(`Kartu ${cardToPlay.color} ${cardToPlay.type} tidak valid.`);
        return null;
    }

    const isWild = cardToPlay.color === 'WILD';
    if (isWild && !UNO_COLORS.includes(chosenColor)) {
        console.warn('Kartu Wild dimainkan tanpa warna pilihan yang valid.');
        return null;
    }

    playerHand.splice(cardIndexInHand, 1);

    // Simpan representasi bersih ke discard pile (tanpa membocorkan properti internal).
    const cardOnPile = { color: cardToPlay.color, type: cardToPlay.type };
    if (isWild) cardOnPile.chosenColor = chosenColor;

    gameState.discardPile.push(cardOnPile);
    gameState.lastPlayedCard = cardOnPile;
    gameState.currentColor = isWild ? chosenColor : cardToPlay.color;

    applyCardEffect(gameState, cardOnPile);

    return gameState;
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
export function applyCardEffect(gameState, card) {
    switch (card.type) {
        case 'SKIP':
            moveToNextPlayer(gameState); // lawan berikutnya
            moveToNextPlayer(gameState); // lewati dia
            gameState.messages.push({ type: 'info', text: 'Giliran pemain berikutnya dilewati.' });
            break;

        case 'REVERSE':
            gameState.direction *= -1;
            if (gameState.players.length === 2) {
                // Dengan 2 pemain, REVERSE berlaku seperti SKIP.
                moveToNextPlayer(gameState);
                moveToNextPlayer(gameState);
                gameState.messages.push({ type: 'info', text: 'Arah berubah — giliran lawan dilewati.' });
            } else {
                moveToNextPlayer(gameState);
                gameState.messages.push({ type: 'info', text: 'Arah permainan berbalik.' });
            }
            break;

        case 'DRAW_TWO':
            gameState.pendingDraw += 2;
            moveToNextPlayer(gameState);
            handlePendingDraw(gameState);
            break;

        case 'WILD_DRAW_FOUR':
            gameState.pendingDraw += 4;
            moveToNextPlayer(gameState);
            handlePendingDraw(gameState);
            break;

        default: // kartu angka & WILD biasa
            moveToNextPlayer(gameState);
            break;
    }
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
