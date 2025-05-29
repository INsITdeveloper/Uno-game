// client/app.js

// Dapatkan elemen-elemen HTML yang akan kita perbarui
const discardPileTopCardEl = document.getElementById('discardPileTopCard');
const playerHandEl = document.querySelector('.hand-cards');
const drawCardBtn = document.getElementById('drawCardBtn');
const gameMessagesEl = document.getElementById('gameMessages');

// Inisialisasi status game dari uno-logic.js (simulasi lokal untuk tampilan awal)
// Nanti ini akan datang dari server
let currentGameState;
let localPlayerIndex = 0; // Untuk simulasi, anggap kita adalah pemain pertama (indeks 0)

// --- Fungsi untuk Merender Kartu ---
/**
 * Membuat elemen HTML untuk satu kartu Uno.
 * @param {object} card - Objek kartu { color, type }.
 * @param {boolean} isPlayable - True jika kartu bisa dimainkan (untuk visualisasi).
 * @returns {HTMLElement} Elemen div yang merepresentasikan kartu.
 */
function createCardElement(card, isPlayable = false) {
    const cardEl = document.createElement('div');
    cardEl.classList.add('card');
    cardEl.classList.add(card.color || 'WILD'); // Tambahkan kelas warna (atau WILD)

    // Tambahkan simbol di tengah
    const centerSymbol = document.createElement('span');
    centerSymbol.classList.add('card-center-symbol');
    centerSymbol.textContent = getCardDisplayValue(card.type);
    cardEl.appendChild(centerSymbol);

    // Tambahkan simbol di pojok
    const cornerSymbolTopLeft = document.createElement('span');
    cornerSymbolTopLeft.classList.add('card-corner-symbol', 'corner-top-left');
    cornerSymbolTopLeft.textContent = getCardDisplayValue(card.type);
    cardEl.appendChild(cornerSymbolTopLeft);

    const cornerSymbolBottomRight = document.createElement('span');
    cornerSymbolBottomRight.classList.add('card-corner-symbol', 'corner-bottom-right');
    cornerSymbolBottomRight.textContent = getCardDisplayValue(card.type);
    cardEl.appendChild(cornerSymbolBottomRight);

    if (isPlayable) {
        cardEl.classList.add('playable'); // Bisa tambahkan gaya highlight jika bisa dimainkan
        // cardEl.onclick = () => playCardHandler(card); // Contoh: klik untuk memainkan kartu
    }
    
    // Simpan data kartu di elemen untuk memudahkan akses nanti
    cardEl.dataset.color = card.color;
    cardEl.dataset.type = card.type;

    return cardEl;
}

/**
 * Mengubah tipe kartu menjadi teks yang mudah dibaca.
 * @param {string|number} type - Tipe kartu.
 * @returns {string} Teks yang akan ditampilkan di kartu.
 */
function getCardDisplayValue(type) {
    switch (type) {
        case 'SKIP': return '🚫'; // Simbol skip
        case 'REVERSE': return '↔️'; // Simbol reverse
        case 'DRAW_TWO': return '+2';
        case 'WILD': return '🌈'; // Simbol Wild
        case 'WILD_DRAW_FOUR': return '+4';
        default: return type.toString(); // Angka
    }
}

// --- Fungsi untuk Memperbarui Tampilan Game ---
function renderGame(gameState) {
    // Render kartu teratas di discard pile
    if (gameState.discardPile.length > 0) {
        discardPileTopCardEl.innerHTML = ''; // Bersihkan dulu
        const topCard = gameState.discardPile[gameState.discardPile.length - 1];
        discardPileTopCardEl.appendChild(createCardElement(topCard));
    }

    // Render kartu di tangan pemain (pemain lokal)
    playerHandEl.innerHTML = ''; // Bersihkan dulu
    const currentPlayerHand = gameState.players[localPlayerIndex];
    currentPlayerHand.forEach((card, index) => {
        // Untuk simulasi, kita bisa cek apakah kartu ini valid dimainkan
        // if (isValidPlay(card, gameState.lastPlayedCard, gameState.currentColor)) {
        //     console.log(`Card ${card.color} ${card.type} is playable`);
        // }
        const cardEl = createCardElement(card); // Kita tidak set isPlayable True dulu, itu nanti di logika server
        cardEl.dataset.cardIndexInHand = index; // Simpan indeks kartu di tangan
        playerHandEl.appendChild(cardEl);
    });

    // Perbarui pesan game (nanti dari server)
    // showMessage(`Giliran Pemain ${gameState.currentPlayerIndex + 1}`, 'info');
}

/**
 * Menampilkan pesan di area pesan game.
 * @param {string} message - Teks pesan.
 * @param {string} type - Tipe pesan (info, success, warning, error).
 */
function showMessage(message, type = 'info') {
    const msgEl = document.createElement('div');
    msgEl.classList.add('message-item', type);
    msgEl.textContent = message;
    gameMessagesEl.prepend(msgEl); // Tambahkan pesan baru di paling atas
    // Batasi jumlah pesan
    if (gameMessagesEl.children.length > 5) {
        gameMessagesEl.removeChild(gameMessagesEl.lastChild);
    }
}


// --- Handler Aksi Pemain (untuk simulasi awal) ---
drawCardBtn.addEventListener('click', () => {
    showMessage("Anda mengambil kartu! (Simulasi)", 'info');
    // Nanti ini akan dikirim ke server: socket.emit('draw_card', { room_id, player_id });
    // const result = playerDrawsCard(currentGameState, localPlayerIndex, true); // True untuk akhiri giliran
    // if (result) {
    //     currentGameState = result;
    //     renderGame(currentGameState);
    //     showMessage(`Anda mengambil kartu ${result.lastDrawnCard.color || 'WILD'} ${result.lastDrawnCard.type}.`, 'success');
    // } else {
    //     showMessage("Tidak bisa mengambil kartu saat ini.", 'error');
    // }
});


// --- Inisialisasi Awal ---
document.addEventListener('DOMContentLoaded', () => {
    // Inisialisasi game secara lokal untuk menampilkan kartu
    // Nanti, inisialisasi ini akan datang dari server setelah bergabung ke room
    currentGameState = initializeGame(3); // Inisialisasi dengan 3 pemain

    if (currentGameState) {
        renderGame(currentGameState);
        showMessage("Game Uno siap! (Simulasi Tampilan)", 'success');
        showMessage(`Warna aktif: ${currentGameState.currentColor || 'Pilih Warna'}`, 'info');
        showMessage(`Giliran Pemain ${currentGameState.currentPlayerIndex + 1}`, 'info');
    } else {
        showMessage("Gagal menginisialisasi game Uno.", 'error');
    }
});

// Expose fungsi-fungsi untuk debugging di console (opsional)
window.createCardElement = createCardElement;
window.renderGame = renderGame;
window.currentGameState = currentGameState;
