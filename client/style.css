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
const playerListEl = document.getElementById('playerList'); // Untuk menampilkan daftar pemain

// --- Variabel Global Game State (akan dikelola oleh server) ---
let currentGameState;
let localPlayerId = 'player_' + Math.random().toString(36).substring(2, 9); // ID unik untuk pemain lokal
let currentRoomCode = null; // Kode room tempat pemain berada
let socket; // Variabel untuk menyimpan koneksi WebSocket

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
        cardEl.onclick = () => playCardHandler(card, cardEl); // Tambahkan handler klik
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
    // Sembunyikan kontrol room jika room sudah terhubung
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


    // Render kartu di tangan pemain lokal
    playerHandEl.innerHTML = ''; // Bersihkan dulu
    if (gameState && gameState.playerHand && gameState.playerHand.length > 0) {
        const topCardOnDiscard = gameState.discardPile[gameState.discardPile.length - 1];
        // Asumsi `isValidPlay` diimport dari `uno-logic.js` dan tersedia di klien
        // Namun, kita tidak akan melakukan validasi play di klien untuk menghindari cheating.
        // Server yang akan memvalidasi.
        gameState.playerHand.forEach((card, index) => {
            // Untuk visualisasi, kita bisa mengasumsikan semua kartu bisa diklik.
            // Validasi sebenarnya akan dilakukan di server.
            const cardEl = createCardElement(card, true); // Set isPlayable true agar bisa diklik
            cardEl.dataset.cardIndexInHand = index; // Simpan indeks kartu di tangan
            playerHandEl.appendChild(cardEl);
        });
    } else if (gameState && gameState.playerHand) {
        showMessage("Anda belum punya kartu di tangan.", 'info');
    }

    // Perbarui pesan game
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

/**
 * Menampilkan daftar pemain di room.
 * @param {Array<string>} playerList - Array ID pemain.
 */
function displayPlayerList(playerList) {
    if (playerList && playerList.length > 0) {
        playerListEl.textContent = `Pemain di room: ${playerList.map(id => id === localPlayerId ? 'Anda' : id.substring(0, 7) + '...').join(', ')}`;
    } else {
        playerListEl.textContent = 'Menunggu pemain...';
    }
}

// --- Handler Aksi Pemain ---
drawCardBtn.addEventListener('click', () => {
    if (socket.readyState === WebSocket.OPEN && currentRoomCode) {
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

// Handler untuk memainkan kartu
function playCardHandler(card, cardEl) {
    if (socket.readyState === WebSocket.OPEN && currentRoomCode) {
        // Untuk kartu WILD, minta pemain memilih warna
        if (card.type === 'WILD' || card.type === 'WILD_DRAW_FOUR') {
            const chosenColor = prompt("Pilih warna (RED, YELLOW, GREEN, BLUE):");
            if (!chosenColor || !['RED', 'YELLOW', 'GREEN', 'BLUE'].includes(chosenColor.toUpperCase())) {
                showMessage("Pilihan warna tidak valid atau dibatalkan.", 'warning');
                return;
            }
            card.chosenColor = chosenColor.toUpperCase(); // Tambahkan warna pilihan ke objek kartu
        }

        socket.send(JSON.stringify({
            type: 'PLAY_CARD',
            roomCode: currentRoomCode,
            playerId: localPlayerId,
            card: card // Kirim objek kartu lengkap
        }));
        showMessage(`Mencoba memainkan kartu ${card.color || 'WILD'} ${card.type}...`, 'info');
    } else {
        showMessage("Tidak terhubung ke room atau server untuk memainkan kartu.", 'error');
    }
}

// --- Inisialisasi WebSocket dan Event Handlers ---
document.addEventListener('DOMContentLoaded', () => {
    // Inisialisasi tampilan awal, sembunyikan game sampai bergabung ke room
    renderGame(null); // Render dengan state kosong untuk menyembunyikan area game
    displayPlayerList(null); // Sembunyikan daftar pemain di awal

    // Asumsi URL server Cloudflare Function Anda adalah sama dengan origin Anda
    // atau URL yang Anda deploy. Contoh: ws://localhost:8787/websocket (untuk lokal)
    // atau wss://your-worker-name.your-username.workers.dev/websocket (untuk produksi)
    // Gunakan window.location.host untuk port yang benar saat development lokal
    const serverUrl = `ws://${window.location.host}/websocket`;
    // Untuk produksi dengan https: const serverUrl = `wss://${window.location.host}/websocket`;
    
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
                displayPlayerList([message.playerId]); // Tampilkan diri sendiri
                break;
            case 'ROOM_JOINED':
                currentRoomCode = message.roomCode;
                showMessage(`Berhasil bergabung ke room: ${currentRoomCode}. Jumlah pemain: ${message.playerCount}`, 'success');
                showRoomStatus(`Anda di room: ${currentRoomCode}. Menunggu game dimulai...`, 'info');
                displayPlayerList(message.playerList);
                break;
            case 'PLAYER_JOINED':
                showMessage(`Pemain ${message.playerId} bergabung! Total pemain: ${message.playerCount}`, 'info');
                showRoomStatus(`Pemain baru bergabung. Total pemain: ${message.playerCount}`, 'info');
                displayPlayerList(message.playerList);
                break;
            case 'PLAYER_LEFT':
                showMessage(`Pemain ${message.playerId} meninggalkan room. Total pemain: ${message.playerCount}`, 'warning');
                showRoomStatus(`Pemain meninggalkan room. Total pemain: ${message.playerCount}`, 'warning');
                displayPlayerList(message.playerList);
                if (message.playerCount === 0) { // Jika room kosong setelah pemain pergi
                    showMessage("Room kosong, kembali ke layar utama.", 'info');
                    currentRoomCode = null;
                    renderGame(null); // Kembali ke tampilan kontrol room
                    displayPlayerList(null);
                }
                break;
            case 'GAME_STARTED':
                showMessage(message.message, 'success');
                // State game awal akan dikirim melalui GAME_STATE_UPDATE
                break;
            case 'GAME_STATE_UPDATE':
                currentGameState = message.gameState;
                renderGame(currentGameState);
                // Tambahan: tampilkan pesan dari server jika ada
                if (currentGameState.messages && currentGameState.messages.length > 0) {
                    currentGameState.messages.forEach(msg => showMessage(msg.text, msg.type));
                    currentGameState.messages = []; // Bersihkan pesan setelah ditampilkan
                }
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
        displayPlayerList(null);
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

    drawCardBtn.addEventListener('click', () => {
        if (socket.readyState === WebSocket.OPEN && currentRoomCode) {
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
});

// Expose fungsi-fungsi untuk debugging di console (opsional)
window.createCardElement = createCardElement;
window.renderGame = renderGame;
window.currentGameState = currentGameState;
window.localPlayerId = localPlayerId;
