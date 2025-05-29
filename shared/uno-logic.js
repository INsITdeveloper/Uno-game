// shared/uno-logic.js

const UNO_COLORS = ['RED', 'YELLOW', 'GREEN', 'BLUE'];
const UNO_NUMBERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const UNO_ACTION_CARDS = ['SKIP', 'REVERSE', 'DRAW_TWO']; // Kartu aksi berwarna
const UNO_WILD_CARDS = ['WILD', 'WILD_DRAW_FOUR']; // Kartu Wild

/**
 * Menginisialisasi state game Uno baru.
 * @param {number} numPlayers - Jumlah pemain dalam game.
 * @returns {object} Objek state game awal.
 */
function initializeGame(numPlayers) {
    if (numPlayers < 2 || numPlayers > 10) {
        console.error("Jumlah pemain harus antara 2 dan 10.");
        return null;
    }

    let deck = createDeck();
    deck = shuffleDeck(deck);

    const players = [];
    for (let i = 0; i < numPlayers; i++) {
        players.push([]); // Setiap pemain mulai dengan tangan kosong
    }

    // Bagikan 7 kartu ke setiap pemain
    for (let i = 0; i < 7; i++) {
        for (let j = 0; j < numPlayers; j++) {
            if (deck.length > 0) {
                players[j].push(deck.pop());
            }
        }
    }

    const discardPile = [];
    let lastPlayedCard = null;
    let currentColor = null;

    // Mulai discard pile dengan kartu angka (bukan aksi atau wild)
    while (deck.length > 0) {
        const topCard = deck.pop();
        if (UNO_NUMBERS.includes(topCard.type)) {
            discardPile.push(topCard);
            lastPlayedCard = topCard;
            currentColor = topCard.color;
            break;
        } else {
            // Jika kartu pertama bukan angka, masukkan kembali ke dek dan kocok ulang
            deck.unshift(topCard); // Masukkan kembali ke awal dek
            deck = shuffleDeck(deck);
        }
    }

    if (!lastPlayedCard) {
        console.error("Tidak dapat menemukan kartu angka untuk memulai permainan.");
        return null;
    }

    return {
        deck: deck,
        discardPile: discardPile,
        players: players, // Array of arrays (tangan setiap pemain)
        currentPlayerIndex: 0,
        direction: 1, // 1 = searah jarum jam, -1 = berlawanan arah jarum jam
        lastPlayedCard: lastPlayedCard,
        currentColor: currentColor,
        pendingDraw: 0, // Untuk Draw Two / Wild Draw Four
        messages: [] // Untuk pesan game
    };
}

/**
 * Membuat satu set dek kartu Uno standar.
 * @returns {Array<object>} Array objek kartu.
 */
function createDeck() {
    let deck = [];

    // Kartu angka (0-9)
    UNO_COLORS.forEach(color => {
        // Satu kartu '0' per warna
        deck.push({ color: color, type: '0' });
        // Dua kartu '1' sampai '9' per warna
        for (let i = 1; i <= 9; i++) {
            deck.push({ color: color, type: i.toString() });
            deck.push({ color: color, type: i.toString() });
        }
    });

    // Kartu aksi (SKIP, REVERSE, DRAW_TWO) - dua per warna
    UNO_COLORS.forEach(color => {
        UNO_ACTION_CARDS.forEach(type => {
            deck.push({ color: color, type: type });
            deck.push({ color: color, type: type });
        });
    });

    // Kartu Wild dan Wild Draw Four - empat masing-masing
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'WILD', type: 'WILD' });
        deck.push({ color: 'WILD', type: 'WILD_DRAW_FOUR' });
    }

    return deck;
}

/**
 * Mengocok array kartu secara acak (Fisher-Yates shuffle).
 * @param {Array<object>} deck - Dek kartu.
 * @returns {Array<object>} Dek yang sudah dikocok.
 */
function shuffleDeck(deck) {
    let currentIndex = deck.length, randomIndex;

    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [deck[currentIndex], deck[randomIndex]] = [
            deck[randomIndex], deck[currentIndex]];
    }
    return deck;
}

/**
 * Memeriksa apakah kartu bisa dimainkan.
 * @param {object} cardToPlay - Kartu yang ingin dimainkan.
 * @param {object} lastPlayedCard - Kartu teratas di discard pile.
 * @param {string} currentColor - Warna yang sedang aktif.
 * @returns {boolean} True jika kartu valid dimainkan, false jika tidak.
 */
function isValidPlay(cardToPlay, lastPlayedCard, currentColor) {
    // Kartu Wild selalu bisa dimainkan
    if (cardToPlay.color === 'WILD') {
        return true;
    }

    // Jika ada pendingDraw (dari +2 atau +4), hanya bisa dibalas dengan +2 atau +4 yang sesuai
    // (Logika ini akan lebih kompleks dan biasanya ditangani di applyCardEffect atau playCard)
    // Untuk isValidPlay sederhana, kita anggap pemain sedang tidak dalam kondisi pendingDraw yang menghalangi.

    // Kartu harus cocok dengan warna atau tipe kartu terakhir yang dimainkan
    // Jika warna kartu yang dimainkan cocok dengan currentColor
    if (cardToPlay.color === currentColor) {
        return true;
    }
    // Jika tipe kartu yang dimainkan cocok dengan tipe kartu terakhir
    if (cardToPlay.type === lastPlayedCard.type) {
        return true;
    }

    return false; // Tidak cocok
}

/**
 * Memainkan kartu.
 * @param {object} gameState - State game saat ini.
 * @param {number} playerIndex - Indeks pemain yang memainkan kartu.
 * @param {object} cardToPlay - Kartu yang dimainkan.
 * @param {string} [chosenColor] - Warna yang dipilih jika kartu adalah WILD.
 * @returns {object|null} State game yang diperbarui, atau null jika tidak valid.
 */
function playCard(gameState, playerIndex, cardToPlay, chosenColor = null) {
    const playerHand = gameState.players[playerIndex];
    const cardIndexInHand = playerHand.findIndex(c => c.color === cardToPlay.color && c.type === cardToPlay.type);

    if (cardIndexInHand === -1) {
        console.warn(`Pemain ${playerIndex} tidak memiliki kartu ${cardToPlay.color} ${cardToPlay.type} di tangan.`);
        return null; // Kartu tidak ada di tangan pemain
    }

    // Validasi apakah kartu bisa dimainkan
    if (!isValidPlay(cardToPlay, gameState.lastPlayedCard, gameState.currentColor)) {
        console.warn(`Kartu ${cardToPlay.color} ${cardToPlay.type} tidak valid untuk dimainkan.`);
        return null;
    }

    // Hapus kartu dari tangan pemain
    playerHand.splice(cardIndexInHand, 1);

    // Tambahkan kartu ke discard pile
    gameState.discardPile.push(cardToPlay);
    gameState.lastPlayedCard = cardToPlay;

    // Tentukan warna saat ini
    if (cardToPlay.color === 'WILD' && chosenColor) {
        gameState.currentColor = chosenColor;
    } else {
        gameState.currentColor = cardToPlay.color;
    }

    // Terapkan efek kartu dan tentukan giliran berikutnya
    applyCardEffect(gameState, cardToPlay);

    // Pindah ke giliran pemain berikutnya, kecuali ada efek kartu yang mengubahnya
    if (cardToPlay.type !== 'SKIP' && cardToPlay.type !== 'REVERSE' && cardToPlay.type !== 'WILD_DRAW_FOUR' && cardToPlay.type !== 'DRAW_TWO') {
        moveToNextPlayer(gameState);
    }
    // (Efek skip/reverse/draw four/draw two akan memanggil moveToNextPlayer atau mengubah indeks di dalam applyCardEffect)

    return gameState;
}

/**
 * Pemain mengambil kartu dari dek.
 * @param {object} gameState - State game saat ini.
 * @param {number} playerIndex - Indeks pemain yang mengambil kartu.
 * @param {boolean} [endTurn=false] - Apakah giliran pemain berakhir setelah mengambil kartu.
 * @returns {object|null} State game yang diperbarui, atau null jika dek kosong.
 */
function playerDrawsCard(gameState, playerIndex, endTurn = false) {
    if (gameState.deck.length === 0) {
        // Jika dek kosong, kocok ulang discard pile dan jadikan dek baru (kecuali kartu teratas)
        if (gameState.discardPile.length > 1) {
            const topCard = gameState.discardPile.pop(); // Simpan kartu teratas
            gameState.deck = shuffleDeck(gameState.discardPile);
            gameState.discardPile = [topCard]; // Buat discard pile baru dengan kartu teratas
            console.log("Dek dikocok ulang dari discard pile.");
            gameState.messages.push({ type: 'info', text: 'Dek dikocok ulang dari tumpukan buangan.' });
        } else {
            console.warn("Dek kosong dan tidak ada kartu untuk dikocok ulang dari discard pile.");
            return null; // Tidak bisa mengambil kartu
        }
    }

    const drawnCard = gameState.deck.pop();
    gameState.players[playerIndex].push(drawnCard);
    gameState.lastDrawnCard = drawnCard; // Untuk informasi di klien
    console.log(`Pemain ${playerIndex} mengambil kartu: ${drawnCard.color} ${drawnCard.type}`);
    gameState.messages.push({ type: 'info', text: `Pemain ${playerIndex + 1} mengambil kartu.` });

    if (endTurn) {
        moveToNextPlayer(gameState);
    }

    return gameState;
}


/**
 * Menerapkan efek kartu aksi.
 * @param {object} gameState - State game saat ini.
 * @param {object} card - Kartu yang baru saja dimainkan.
 */
function applyCardEffect(gameState, card) {
    switch (card.type) {
        case 'SKIP':
            console.log('Efek SKIP: Melewatkan giliran pemain berikutnya.');
            moveToNextPlayer(gameState); // Maju sekali untuk melewatkan pemain berikutnya
            moveToNextPlayer(gameState); // Maju lagi untuk ke pemain setelah yang dilewatkan
            gameState.messages.push({ type: 'info', text: `Giliran dilewati untuk pemain berikutnya.` });
            break;
        case 'REVERSE':
            console.log('Efek REVERSE: Mengubah arah permainan.');
            gameState.direction *= -1; // Balik arah
            // Jika hanya 2 pemain, Reverse bekerja seperti Skip
            if (gameState.players.length === 2) {
                moveToNextPlayer(gameState); // Maju sekali untuk melewatkan pemain berikutnya
                moveToNextPlayer(gameState); // Maju lagi untuk ke pemain setelah yang dilewatkan
                gameState.messages.push({ type: 'info', text: `Arah berubah, dan giliran dilewati.` });
            } else {
                moveToNextPlayer(gameState); // Pindah giliran secara normal setelah arah berubah
                gameState.messages.push({ type: 'info', text: `Arah permainan berubah.` });
            }
            break;
        case 'DRAW_TWO':
            console.log('Efek DRAW_TWO: Pemain berikutnya mengambil 2 kartu.');
            gameState.pendingDraw += 2;
            moveToNextPlayer(gameState); // Pindah ke pemain berikutnya
            // Pemain berikutnya akan mengambil kartu di awal giliran mereka
            handlePendingDraw(gameState); // Segera terapkan efek
            gameState.messages.push({ type: 'info', text: `Pemain berikutnya mengambil 2 kartu.` });
            break;
        case 'WILD_DRAW_FOUR':
            console.log('Efek WILD_DRAW_FOUR: Pemain berikutnya mengambil 4 kartu.');
            gameState.pendingDraw += 4;
            moveToNextPlayer(gameState); // Pindah ke pemain berikutnya
            handlePendingDraw(gameState); // Segera terapkan efek
            gameState.messages.push({ type: 'info', text: `Pemain berikutnya mengambil 4 kartu.` });
            break;
        // Kartu WILD hanya mengubah warna, tidak ada efek tambahan yang mempengaruhi giliran di sini
        case 'WILD':
            gameState.messages.push({ type: 'info', text: `Warna berubah menjadi ${gameState.currentColor}.` });
            moveToNextPlayer(gameState); // Pindah giliran secara normal
            break;
        default: // Kartu angka
            moveToNextPlayer(gameState); // Pindah giliran secara normal
            break;
    }
}

/**
 * Menangani kartu yang harus diambil (dari DRAW_TWO atau WILD_DRAW_FOUR).
 * @param {object} gameState - State game saat ini.
 */
function handlePendingDraw(gameState) {
    if (gameState.pendingDraw > 0) {
        const playerToDraw = gameState.currentPlayerIndex;
        console.log(`Pemain ${playerToDraw} harus mengambil ${gameState.pendingDraw} kartu.`);
        for (let i = 0; i < gameState.pendingDraw; i++) {
            playerDrawsCard(gameState, playerToDraw, false); // Ambil kartu, jangan akhiri giliran
        }
        gameState.pendingDraw = 0; // Reset pending draw
        // Setelah mengambil kartu, giliran pemain yang terkena efek draw dilewati
        moveToNextPlayer(gameState);
    }
}


/**
 * Memindahkan giliran ke pemain berikutnya berdasarkan arah.
 * @param {object} gameState - State game saat ini.
 */
function moveToNextPlayer(gameState) {
    gameState.currentPlayerIndex += gameState.direction;

    // Lingkari indeks pemain agar tetap dalam batas array
    if (gameState.currentPlayerIndex >= gameState.players.length) {
        gameState.currentPlayerIndex = 0;
    } else if (gameState.currentPlayerIndex < 0) {
        gameState.currentPlayerIndex = gameState.players.length - 1;
    }
    console.log(`Giliran sekarang pemain: ${gameState.currentPlayerIndex}`);
}

// Ekspor fungsi-fungsi agar dapat digunakan di modul lain
export {
    initializeGame,
    createDeck,
    shuffleDeck,
    isValidPlay,
    playCard,
    playerDrawsCard,
    applyCardEffect,
    moveToNextPlayer,
    UNO_COLORS,
    UNO_NUMBERS,
    UNO_ACTION_CARDS,
    UNO_WILD_CARDS
};
