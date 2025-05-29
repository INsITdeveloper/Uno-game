// client/app.js

// Dapatkan elemen-elemen HTML yang akan kita perbarui
const discardPileTopCardEl = document.getElementById('discardPileTopCard');
const playerHandEl = document.querySelector('.hand-cards');
const drawCardBtn = document.getElementById('drawCardBtn');
const gameMessagesEl = document.getElementById('gameMessages');

// Elemen baru untuk kontrol room
const roomCodeInput = document.getElementById('roomCodeInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const createRoomBtn = document.getElementById('createRoomBtn');
const roomStatusMessageEl = document.getElementById('roomStatusMessage');
const roomControlsEl = document.querySelector('.room-controls'); // Untuk menyembunyikan/menampilkan

// --- Variabel Global Game State (akan dikelola oleh server) ---
let currentGameState;
let localPlayerId = 'player_' + Math.random().toString(36).substring(2, 9); // ID unik untuk pemain lokal
let currentRoomCode = null; // Kode room tempat pemain berada
let socket; // Variabel untuk menyimpan koneksi WebSocket

// --- Fungsi untuk Merender Kartu (tetap sama) ---
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

// --- Fungsi untuk Memperbarui Tampilan Game (sedikit modifikasi) ---
function renderGame(gameState) {
    // Sembunyikan kontrol room setelah game dimulai (atau room berhasil dibuat/bergabung)
    if (currentRoomCode) {
        roomControlsEl.style.display = 'none';
        discardPileTopCardEl.parentElement.style.display = 'flex'; // Tampilkan discard pile
        playerHandEl.parentElement.style.display = 'block'; // Tampilkan player hand
        drawCardBtn.style.display = 'block'; // Tampilkan tombol ambil kartu
    } else {
        roomControlsEl.style.display = 'block';
        discardPileTopCardEl.parentElement.style.display = 'none'; // Sembunyikan discard pile
        playerHandEl.parentElement.style.display = 'none'; // Sembunyikan player hand
        drawCardBtn.style.display = 'none'; // Sembunyikan tombol ambil kartu
    }

    // Render kartu teratas di discard pile
    if (gameState && gameState.discardPile && gameState.discardPile.length > 0) {
        discardPileTopCardEl.innerHTML = ''; // Bersihkan dulu
        const topCard = gameState.discardPile[gameState.discardPile.length - 1];
        discardPileTopCardEl.appendChild(createCardElement(topCard));
    } else if (gameState && gameState.discardPile) { // Jika discard pile kosong tapi game state ada
        discardPileTopCardEl.innerHTML = '<div class="card empty"></div>'; // Placeholder
    }


    // Render kartu di tangan pemain (pemain lokal)
    playerHandEl.innerHTML = ''; // Bersihkan dulu
    // Di sini kita perlu tahu indeks pemain lokal dari server, atau server yang mengirimkan hand kita saja
    // Untuk saat ini, kita asumsikan server akan mengirimkan 'hand' kita secara langsung
    if (gameState && gameState.playerHand && gameState.playerHand.length > 0) {
        gameState.playerHand.forEach((card, index) => {
            const cardEl = createCardElement(card);
            cardEl.dataset.cardIndexInHand = index; // Simpan indeks kartu di tangan
            playerHandEl.appendChild(cardEl);
        });
    } else if (gameState && gameState.playerHand) {
        showMessage("Anda belum punya kartu di tangan.", 'info');
    }

    // Perbarui pesan game (nanti dari server)
    if (gameState && gameState.currentPlayerIndex !== undefined) {
         showMessage(`Giliran Pemain ${gameState.currentPlayerIndex + 1}`, 'info');
    }
    if (gameState && gameState.currentColor) {
        showMessage(`Warna aktif: ${gameState.currentColor}`, 'info');
    }
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

/**
 * Menampilkan pesan status room.
 * @param {string} message - Teks pesan.
 * @param {string} type - Tipe pesan (info, success, warning, error).
 */
function showRoomStatus(message, type = 'info') {
    roomStatusMessageEl.textContent = message;
    roomStatusMessageEl.className = 'message-item ' + type;
}

// --- Inisialisasi WebSocket dan Event Handlers ---
document.addEventListener('DOMContentLoaded', () => {
    // Inisialisasi tampilan awal, sembunyikan game sampai bergabung ke room
    renderGame(null); // Render dengan state kosong untuk menyembunyikan area game

    // Asumsikan URL server Cloudflare Function Anda adalah sama dengan origin Anda
    // atau URL yang Anda deploy. Contoh: ws://localhost:8787/websocket (untuk lokal)
    // atau wss://your-worker-name.your-username.workers.dev/websocket (untuk produksi)
    const serverUrl = window.location.origin.replace('http', 'ws') + '/websocket';
    
    // Inisialisasi koneksi WebSocket
    socket = new WebSocket(serverUrl);

    socket.onopen = (event) => {
        console.log('Koneksi WebSocket berhasil dibuka:', event);
        showMessage('Terhubung ke server game!', 'success');
        showRoomStatus('Silakan buat atau gabung room.', 'info');
    };

    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log('Pesan diterima dari server:', message);

        switch (message.type) {
            case 'ROOM_CREATED':
                currentRoomCode = message.roomCode;
                showMessage(`Room berhasil dibuat! Kode: ${currentRoomCode}`, 'success');
                showRoomStatus(`Anda di room: ${currentRoomCode}. Menunggu pemain lain...`, 'info');
                // Server akan mengirimkan state game awal setelah semua pemain siap
                break;
            case 'ROOM_JOINED':
                currentRoomCode = message.roomCode;
                showMessage(`Berhasil bergabung ke room: ${currentRoomCode}. Jumlah pemain: ${message.playerCount}`, 'success');
                showRoomStatus(`Anda di room: ${currentRoomCode}. Menunggu game dimulai...`, 'info');
                // Server akan mengirimkan state game awal
                break;
            case 'PLAYER_JOINED':
                showMessage(`Pemain ${message.playerId} bergabung! Total pemain: ${message.playerCount}`, 'info');
                showRoomStatus(`Pemain baru bergabung. Total pemain: ${message.playerCount}`, 'info');
                break;
            case 'PLAYER_LEFT':
                showMessage(`Pemain ${message.playerId} meninggalkan room. Total pemain: ${message.playerCount}`, 'warning');
                showRoomStatus(`Pemain meninggalkan room. Total pemain: ${message.playerCount}`, 'warning');
                if (message.playerCount === 0) { // Jika room kosong setelah pemain pergi
                    showMessage("Room kosong, kembali ke layar utama.", 'info');
                    currentRoomCode = null;
                    renderGame(null); // Kembali ke tampilan kontrol room
                }
                break;
            case 'GAME_STATE_UPDATE':
                // Ini adalah pesan utama yang akan dikirim server untuk memperbarui seluruh UI game
                currentGameState = message.gameState;
                renderGame(currentGameState);
                showMessage('Game state diperbarui.', 'info');
                break;
            case 'ERROR':
                showMessage(`Error: ${message.message}`, 'error');
                showRoomStatus(`Error: ${message.message}`, 'error');
                break;
            default:
                console.warn('Tipe pesan tidak dikenal dari server:', message.type);
                showMessage(`Pesan tidak dikenal: ${message.type}`, 'warning');
        }
    };

    socket.onclose = (event) => {
        console.log('Koneksi WebSocket ditutup:', event);
        showMessage('Koneksi ke server terputus.', 'error');
        showRoomStatus('Koneksi terputus. Silakan refresh halaman.', 'error');
        currentRoomCode = null;
        renderGame(null); // Kembali ke tampilan kontrol room
    };

    socket.onerror = (error) => {
        console.error('WebSocket Error:', error);
        showMessage('Terjadi kesalahan pada koneksi WebSocket.', 'error');
        showRoomStatus('Kesalahan koneksi.', 'error');
    };

    // --- Event Listener untuk Kontrol Room ---
    createRoomBtn.addEventListener('click', () => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'CREATE_ROOM',
                playerId: localPlayerId // Kirim ID pemain lokal
            }));
            showRoomStatus('Mencoba membuat room...', 'info');
        } else {
            showMessage('Tidak terhubung ke server. Coba lagi nanti.', 'error');
        }
    });

    joinRoomBtn.addEventListener('click', () => {
        const roomCode = roomCodeInput.value.trim();
        if (roomCode && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'JOIN_ROOM',
                roomCode: roomCode,
                playerId: localPlayerId // Kirim ID pemain lokal
            }));
            showRoomStatus('Mencoba bergabung ke room...', 'info');
        } else if (!roomCode) {
            showRoomStatus('Mohon masukkan kode room.', 'warning');
        } else {
            showMessage('Tidak terhubung ke server. Coba lagi nanti.', 'error');
        }
    });

    // --- Handler Aksi Pemain (untuk simulasi awal - sekarang akan dikirim ke server) ---
    drawCardBtn.addEventListener('click', () => {
        if (socket.readyState === WebSocket.OPEN && currentRoomCode) {
            // Nanti ini akan dikirim ke server:
            socket.send(JSON.stringify({
                type: 'DRAW_CARD',
                roomCode: currentRoomCode,
                playerId: localPlayerId
            }));
            showMessage("Mengirim permintaan ambil kartu ke server...", 'info');
        } else {
            showMessage("Tidak terhubung ke room atau server.", 'error');
        }
    });

    // Kode inisialisasi game lokal yang lama sekarang tidak relevan
    // currentGameState = initializeGame(3); // Ini akan datang dari server
    // if (currentGameState) {
    //     renderGame(currentGameState);
    //     showMessage("Game Uno siap! (Simulasi Tampilan)", 'success');
    //     showMessage(`Warna aktif: ${currentGameState.currentColor || 'Pilih Warna'}`, 'info');
    //     showMessage(`Giliran Pemain ${currentGameState.currentPlayerIndex + 1}`, 'info');
    // } else {
    //     showMessage("Gagal menginisialisasi game Uno.", 'error');
    // }
});

// Expose fungsi-fungsi untuk debugging di console (opsional)
window.createCardElement = createCardElement;
window.renderGame = renderGame;
window.currentGameState = currentGameState;
window.localPlayerId = localPlayerId; // Agar bisa dilihat di console
