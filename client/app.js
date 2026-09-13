// client/app.js
// Klien Uno: hanya menampilkan state dan mengirim niat ke server.
// Seluruh validasi tetap dilakukan server.

'use strict';

// --- Referensi elemen -------------------------------------------------------
const el = {
    roomControls: document.getElementById('roomControls'),
    roomBar: document.getElementById('roomBar'),
    roomCodeLabel: document.getElementById('roomCodeLabel'),
    roomCodeInput: document.getElementById('roomCodeInput'),
    joinRoomBtn: document.getElementById('joinRoomBtn'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    startGameBtn: document.getElementById('startGameBtn'),
    leaveRoomBtn: document.getElementById('leaveRoomBtn'),
    roomStatusMessage: document.getElementById('roomStatusMessage'),
    playerList: document.getElementById('playerList'),

    board: document.getElementById('board'),
    turnIndicator: document.getElementById('turnIndicator'),
    activeColor: document.getElementById('activeColor'),
    deckInfo: document.getElementById('deckInfo'),
    opponents: document.getElementById('opponents'),
    discardPileTopCard: document.getElementById('discardPileTopCard'),
    drawPile: document.getElementById('drawPile'),
    playerHand: document.querySelector('.hand-cards'),
    drawCardBtn: document.getElementById('drawCardBtn'),

    gameMessages: document.getElementById('gameMessages'),

    colorPicker: document.getElementById('colorPicker'),
    cancelColorBtn: document.getElementById('cancelColorBtn')
};

// --- State klien ------------------------------------------------------------
const app = {
    socket: null,
    localPlayerId: 'player_' + Math.random().toString(36).slice(2, 9),
    roomCode: null,
    players: [],        // [{ id, count, isYou }]
    game: null,         // state game terakhir dari server
    gameRunning: false,
    isMyTurn: false
};

// --- Util -------------------------------------------------------------------

function send(payload) {
    if (app.socket && app.socket.readyState === WebSocket.OPEN) {
        app.socket.send(JSON.stringify(payload));
        return true;
    }
    showMessage('Tidak terhubung ke server.', 'error');
    return false;
}

function showMessage(text, type = 'info') {
    const msgEl = document.createElement('div');
    msgEl.classList.add('message-item', type);
    msgEl.textContent = text;
    el.gameMessages.prepend(msgEl);
    while (el.gameMessages.children.length > 6) {
        el.gameMessages.removeChild(el.gameMessages.lastChild);
    }
}

function setRoomStatus(text, type = 'info') {
    el.roomStatusMessage.textContent = text;
    el.roomStatusMessage.className = 'message-item ' + type;
}

function getCardDisplayValue(type) {
    switch (type) {
        case 'SKIP': return '🚫';
        case 'REVERSE': return '↔';
        case 'DRAW_TWO': return '+2';
        case 'WILD': return '🌈';
        case 'WILD_DRAW_FOUR': return '+4';
        default: return String(type);
    }
}

function colorLabel(color) {
    return { RED: 'Merah', YELLOW: 'Kuning', GREEN: 'Hijau', BLUE: 'Biru' }[color] || color || '-';
}

/** Salinan logika validasi untuk highlight saja (server tetap penentu akhir). */
function isCardPlayable(card, topCard, currentColor) {
    if (!topCard) return true;
    if (card.color === 'WILD') return true;
    if (card.color === currentColor) return true;
    if (card.type === topCard.type) return true;
    return false;
}

// --- Render kartu -----------------------------------------------------------

/** Nama file gambar kartu. Wild tidak memakai prefix warna. */
function cardImageName(card) {
    return card.color === 'WILD' ? `${card.type}.png` : `${card.color}_${card.type}.png`;
}

function createCardElement(card, { playable = false, small = false, onClick = null } = {}) {
    const cardEl = document.createElement('div');
    cardEl.classList.add('card', 'image-card');
    if (small) cardEl.classList.add('small');
    if (card.color === 'WILD' && card.chosenColor) cardEl.classList.add('chosen-' + card.chosenColor);

    const img = document.createElement('img');
    img.src = `assets/cards/${cardImageName(card)}`;
    img.alt = `${card.color} ${getCardDisplayValue(card.type)}`;
    img.draggable = false;
    img.decoding = 'async';
    cardEl.appendChild(img);

    cardEl.dataset.color = card.color;
    cardEl.dataset.type = card.type;

    if (playable && onClick) {
        cardEl.classList.add('playable');
        cardEl.addEventListener('click', onClick);
    } else {
        cardEl.classList.add('dim');
    }

    return cardEl;
}

// --- Render game ------------------------------------------------------------

function renderGame() {
    const inRoom = Boolean(app.roomCode);
    el.roomControls.hidden = inRoom;
    el.roomBar.hidden = !inRoom;
    el.board.hidden = !inRoom;

    if (!inRoom) return;

    el.roomCodeLabel.textContent = `Room: ${app.roomCode}`;
    el.startGameBtn.hidden = app.gameRunning;
    el.startGameBtn.disabled = app.players.length < 2;

    const game = app.game;
    if (!game) {
        el.turnIndicator.textContent = 'Menunggu game dimulai...';
        el.activeColor.textContent = '';
        el.deckInfo.textContent = '';
        el.opponents.innerHTML = '';
        el.playerHand.innerHTML = '';
        el.discardPileTopCard.innerHTML = '';
        el.drawCardBtn.disabled = true;
        return;
    }

    const topCard = game.discardPile && game.discardPile.length
        ? game.discardPile[game.discardPile.length - 1]
        : null;

    // Discard pile
    el.discardPileTopCard.innerHTML = '';
    if (topCard) {
        el.discardPileTopCard.appendChild(createCardElement(topCard, { small: true }));
    } else {
        el.discardPileTopCard.innerHTML = '<div class="card small empty"></div>';
    }

    // Papan informasi
    const isMyTurn = game.currentPlayerId === app.localPlayerId;
    app.isMyTurn = isMyTurn;
    el.turnIndicator.textContent = game.winner !== null
        ? 'Game selesai'
        : (isMyTurn ? '⭐ GILIRAN KAMU' : 'Menunggu lawan...');
    el.turnIndicator.classList.toggle('mine', isMyTurn);

    el.activeColor.textContent = 'Warna aktif: ' + colorLabel(game.currentColor);
    el.activeColor.dataset.color = game.currentColor || '';
    el.deckInfo.textContent = `Dek: ${game.deckCount} kartu` + (game.direction === -1 ? ' • arah terbalik' : '');

    // Daftar lawan
    el.opponents.innerHTML = '';
    (game.players || []).forEach((p) => {
        if (p.isYou) return;
        const chip = document.createElement('div');
        chip.classList.add('opponent');
        if (p.id === game.currentPlayerId) chip.classList.add('active');
        chip.textContent = `${(p.id || '?').substring(0, 7)}… — ${p.count} kartu`;
        el.opponents.appendChild(chip);
    });

    // Tangan sendiri
    el.playerHand.innerHTML = '';
    (game.playerHand || []).forEach((card, index) => {
        const playable = game.winner === null && isMyTurn && isCardPlayable(card, topCard, game.currentColor);
        const cardEl = createCardElement(card, {
            playable,
            onClick: () => handlePlayCard(card)
        });
        cardEl.dataset.cardIndexInHand = index;
        el.playerHand.appendChild(cardEl);
    });

    el.drawCardBtn.disabled = !(isMyTurn && game.winner === null);
}

function renderPlayers() {
    if (!app.players.length) {
        el.playerList.textContent = 'Menunggu pemain...';
        return;
    }
    el.playerList.textContent = 'Pemain di room: ' + app.players
        .map((id) => (id === app.localPlayerId ? 'Anda' : id.substring(0, 7) + '…'))
        .join(', ');
}

function resetToLobby(message) {
    app.roomCode = null;
    app.players = [];
    app.game = null;
    app.gameRunning = false;
    app.isMyTurn = false;
    el.startGameBtn.hidden = true;
    renderGame();
    renderPlayers();
    if (message) setRoomStatus(message, 'info');
}

// --- Aksi pemain ------------------------------------------------------------

function pickColor() {
    return new Promise((resolve) => {
        el.colorPicker.hidden = false;
        const buttons = Array.from(el.colorPicker.querySelectorAll('[data-color]'));

        const cleanup = () => {
            el.colorPicker.hidden = true;
            buttons.forEach((b) => b.removeEventListener('click', onClick));
            el.cancelColorBtn.removeEventListener('click', onCancel);
        };
        const onClick = (e) => {
            const value = e.currentTarget.dataset.color;
            cleanup();
            resolve(value || null);
        };
        const onCancel = () => {
            cleanup();
            resolve(null);
        };

        buttons.forEach((b) => b.addEventListener('click', onClick));
        el.cancelColorBtn.addEventListener('click', onCancel);
    });
}

async function handlePlayCard(card) {
    if (!app.isMyTurn) {
        showMessage('Belum giliranmu.', 'warning');
        return;
    }

    let chosenColor = null;
    if (card.color === 'WILD') {
        chosenColor = await pickColor();
        if (!chosenColor) {
            showMessage('Pemilihan warna dibatalkan.', 'warning');
            return;
        }
    }

    send({
        type: 'PLAY_CARD',
        card: { color: card.color, type: card.type },
        chosenColor
    });
}

function drawCard() {
    if (!app.isMyTurn) {
        showMessage('Belum giliranmu.', 'warning');
        return;
    }
    send({ type: 'DRAW_CARD' });
}

// Satu listener saja untuk tombol ambil kartu (versi lama mendaftarkannya dua kali).
el.drawCardBtn.addEventListener('click', drawCard);
el.drawPile.addEventListener('click', drawCard);

el.createRoomBtn.addEventListener('click', () => {
    if (send({ type: 'CREATE_ROOM', playerId: app.localPlayerId })) {
        setRoomStatus('Membuat room...', 'info');
    }
});

el.joinRoomBtn.addEventListener('click', () => {
    const roomCode = el.roomCodeInput.value.trim().toUpperCase();
    if (!roomCode) {
        setRoomStatus('Masukkan kode room terlebih dahulu.', 'warning');
        return;
    }
    if (send({ type: 'JOIN_ROOM', roomCode, playerId: app.localPlayerId })) {
        setRoomStatus('Bergabung ke room...', 'info');
    }
});

el.roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.joinRoomBtn.click();
});

el.startGameBtn.addEventListener('click', () => {
    if (send({ type: 'START_GAME' })) {
        setRoomStatus('Memulai game...', 'info');
    }
});

el.leaveRoomBtn.addEventListener('click', () => {
    send({ type: 'LEAVE_ROOM' });
    resetToLobby('Anda keluar dari room.');
});

// --- WebSocket --------------------------------------------------------------

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const serverUrl = `${protocol}//${window.location.host}/websocket`;

    app.socket = new WebSocket(serverUrl);

    app.socket.addEventListener('open', () => {
        setRoomStatus('Terhubung ke server. Silakan buat atau gabung room.', 'success');
    });

    app.socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            console.warn('Pesan bukan JSON:', event.data);
            return;
        }

        switch (message.type) {
            case 'ROOM_CREATED':
                app.roomCode = message.roomCode;
                app.players = message.playerList || [message.playerId];
                app.game = null;
                app.gameRunning = false;
                showMessage(`Room dibuat! Kode: ${message.roomCode}`, 'success');
                setRoomStatus(`Anda di room ${message.roomCode}. Bagikan kode ini ke temanmu, lalu tekan "Mulai Game".`, 'info');
                renderPlayers();
                renderGame();
                break;

            case 'ROOM_JOINED':
                app.roomCode = message.roomCode;
                app.players = message.playerList || [];
                app.game = null;
                app.gameRunning = false;
                showMessage(`Bergabung ke room ${message.roomCode}.`, 'success');
                setRoomStatus(`Anda di room ${message.roomCode}. Menunggu host memulai game...`, 'info');
                renderPlayers();
                renderGame();
                break;

            case 'PLAYER_JOINED':
                app.players = message.playerList || app.players;
                showMessage(`Pemain ${message.playerId.substring(0, 7)}… bergabung (${message.playerCount} pemain).`, 'info');
                setRoomStatus(`Total ${message.playerCount} pemain di room.`, 'info');
                renderPlayers();
                renderGame();
                break;

            case 'PLAYER_LEFT':
                app.players = message.playerList || [];
                showMessage(`Pemain ${message.playerId.substring(0, 7)}… keluar (${message.playerCount} pemain).`, 'warning');
                if (message.playerCount === 0) {
                    resetToLobby('Room kosong.');
                } else {
                    renderPlayers();
                    renderGame();
                }
                break;

            case 'GAME_STARTED':
                app.gameRunning = true;
                showMessage(message.message, 'success');
                setRoomStatus('Game berjalan.', 'success');
                renderGame();
                break;

            case 'GAME_STATE_UPDATE': {
                app.game = message.gameState;
                // Pesan dari server hanya ditampilkan sekali (server sudah mengosongkan antrian).
                (message.gameState.messages || []).forEach((m) => showMessage(m.text, m.type));
                renderGame();
                break;
            }

            case 'GAME_OVER':
                app.gameRunning = false;
                // Tandai papan sebagai selesai (server membawa game state terakhir sebelum GAME_OVER).
                if (app.game) app.game = { ...app.game, winner: message.winnerId };
                showMessage(message.message, 'success');
                setRoomStatus(`${message.message} Tekan "Mulai Game" untuk main lagi.`, 'success');
                if (app.game && message.winnerId === app.localPlayerId) {
                    showMessage('Selamat, kamu menang! 🎉', 'success');
                }
                renderGame();
                break;

            case 'GAME_ABORTED':
                app.gameRunning = false;
                app.game = null;
                showMessage(message.message, 'warning');
                setRoomStatus(message.message, 'warning');
                renderGame();
                break;

            case 'ERROR':
                showMessage('Error: ' + message.message, 'error');
                setRoomStatus('Error: ' + message.message, 'error');
                break;

            default:
                console.warn('Tipe pesan tidak dikenal:', message.type);
        }
    });

    app.socket.addEventListener('close', () => {
        showMessage('Koneksi ke server terputus.', 'error');
        setRoomStatus('Koneksi terputus. Muat ulang halaman untuk menyambung kembali.', 'error');
        app.gameRunning = false;
        resetToLobby(null);
    });

    app.socket.addEventListener('error', () => {
        showMessage('Terjadi kesalahan pada koneksi WebSocket.', 'error');
    });
}

// --- Bootstrap --------------------------------------------------------------
resetToLobby(null);
setRoomStatus('Menghubungkan ke server...', 'info');
connect();

// Untuk debugging di console browser
window.unoApp = app;
