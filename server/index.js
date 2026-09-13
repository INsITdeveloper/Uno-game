// server/index.js
// Cloudflare Worker: WebSocket + otorisasi room untuk game Uno.
//
// PRINSIP: server adalah satu-satunya sumber kebenaran.
// Klien hanya menyampaikan niat ("saya mau main kartu X"); server yang memutuskan sah/tidaknya.

import {
    initializeGame,
    playCard,
    playerDrawsCard,
    UNO_COLORS,
    UNO_NUMBERS,
    UNO_ACTION_CARDS,
    UNO_WILD_CARDS,
    MIN_PLAYERS,
    MAX_PLAYERS
} from '../shared/uno-logic.js';

/**
 * @typedef {Object} Room
 * @property {Map<string, WebSocket>} players
 * @property {string[]} playerOrder
 * @property {object|null} gameLogicState
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

/** Pemetaan socket server -> identitas pemain. Sumber kebenaran identitas, bukan message.playerId. */
/** @type {Map<WebSocket, {playerId: string, roomCode: string}>} */
const connections = new Map();

const VALID_CARD_COLORS = new Set([...UNO_COLORS, 'WILD']);
const VALID_CARD_TYPES = new Set([...UNO_NUMBERS, ...UNO_ACTION_CARDS, ...UNO_WILD_CARDS]);
const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WS_MESSAGE_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function generateUniqueRoomCode() {
    let code;
    let attempts = 0;
    do {
        code = Math.random().toString(36).substring(2, 7).toUpperCase();
        attempts++;
    } while (rooms.has(code) && attempts < 100);
    return code;
}

function sendTo(ws, message) {
    try {
        ws.send(JSON.stringify(message));
    } catch (err) {
        console.error('Gagal mengirim pesan WebSocket:', err);
    }
}

function sendError(ws, message) {
    sendTo(ws, { type: 'ERROR', message });
}

function broadcast(roomCode, message, excludePlayerId = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    for (const [playerId, ws] of room.players) {
        if (excludePlayerId && playerId === excludePlayerId) continue;
        sendTo(ws, message);
    }
}

function sanitizePlayerId(raw) {
    return typeof raw === 'string' && PLAYER_ID_PATTERN.test(raw) ? raw : null;
}

function sanitizeCard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const { color, type } = raw;
    if (typeof color !== 'string' || typeof type !== 'string') return null;
    if (!VALID_CARD_COLORS.has(color) || !VALID_CARD_TYPES.has(type)) return null;
    return { color, type };
}

/** State yang dikirim ke satu pemain: hanya tangan pemain itu yang terlihat penuh. */
function buildStateFor(room, index, pendingMessages) {
    const game = room.gameLogicState;
    return {
        playerHand: game.players[index],
        players: game.players.map((hand, i) => ({
            id: room.playerOrder[i] ?? null,
            count: hand.length,
            isYou: i === index
        })),
        discardPile: game.discardPile,
        lastPlayedCard: game.lastPlayedCard,
        currentColor: game.currentColor,
        currentPlayerIndex: game.currentPlayerIndex,
        currentPlayerId: room.playerOrder[game.currentPlayerIndex] ?? null,
        direction: game.direction,
        pendingDraw: game.pendingDraw,
        deckCount: game.deck.length,
        winner: game.winner,
        messages: pendingMessages
    };
}

/**
 * Kirim state game ke semua pemain. Antrian pesan di-drain SEKALI supaya
 * tidak terkirim berulang maupun hilang.
 */
function broadcastGameState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.gameLogicState) return;

    const pending = room.gameLogicState.messages.splice(0); // drain sekali

    room.playerOrder.forEach((playerId, index) => {
        const ws = room.players.get(playerId);
        if (ws) {
            sendTo(ws, {
                type: 'GAME_STATE_UPDATE',
                gameState: buildStateFor(room, index, pending)
            });
        }
    });
}

function startGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const numPlayers = room.playerOrder.length;
    if (numPlayers < MIN_PLAYERS || numPlayers > MAX_PLAYERS) {
        sendError(room.players.values().next().value, `Butuh ${MIN_PLAYERS}-${MAX_PLAYERS} pemain.`);
        return;
    }

    const state = initializeGame(numPlayers);
    if (!state) {
        broadcast(roomCode, { type: 'ERROR', message: 'Gagal menginisialisasi game.' });
        return;
    }

    room.gameLogicState = state;
    console.log(`Room ${roomCode}: game dimulai dengan ${numPlayers} pemain.`);

    broadcast(roomCode, {
        type: 'GAME_STARTED',
        message: `Game dimulai dengan ${numPlayers} pemain!`
    });
    broadcastGameState(roomCode);
}

function endGame(roomCode, winnerIndex) {
    const room = rooms.get(roomCode);
    if (!room || !room.gameLogicState) return;

    const winnerId = room.playerOrder[winnerIndex] ?? null;
    room.gameLogicState.winner = winnerIndex;

    broadcast(roomCode, {
        type: 'GAME_OVER',
        winnerId,
        message: `Pemain ${winnerId ? winnerId.substring(0, 7) : '?'} menang!`
    });

    // Room tetap hidup supaya pemain bisa main lagi / pemain baru bisa masuk.
    room.gameLogicState = null;
}

/**
 * Keluarkan sebuah socket dari room-nya (dipakai untuk LEAVE_ROOM dan saat koneksi ditutup).
 * Menjaga agar playerOrder dan gameLogicState.players selalu sinkron.
 */
function removeSocketFromRoom(server) {
    const meta = connections.get(server);
    if (!meta) return;

    connections.delete(server);

    const { roomCode, playerId } = meta;
    const room = rooms.get(roomCode);
    if (!room) return;

    // Pastikan socket ini masih yang terdaftar (hindari race dengan rejoin).
    if (room.players.get(playerId) !== server) return;

    const orderIndex = room.playerOrder.indexOf(playerId);
    room.players.delete(playerId);
    if (orderIndex !== -1) room.playerOrder.splice(orderIndex, 1);

    if (room.gameLogicState && orderIndex !== -1) {
        const game = room.gameLogicState;

        // Buang tangan pemain yang keluar agar indeks tangan tetap cocok dengan playerOrder.
        if (orderIndex < game.players.length) {
            game.players.splice(orderIndex, 1);
        }

        if (game.players.length < MIN_PLAYERS) {
            room.gameLogicState = null;
            broadcast(roomCode, {
                type: 'GAME_ABORTED',
                message: 'Game dihentikan karena pemain tidak cukup.'
            });
        } else {
            // Sesuaikan indeks giliran setelah satu pemain hilang.
            const before = game.currentPlayerIndex;
            if (orderIndex === before) {
                game.currentPlayerIndex = orderIndex + (game.direction === -1 ? -1 : 0);
            } else if (orderIndex < before) {
                game.currentPlayerIndex = before - 1;
            }
            const total = game.players.length;
            game.currentPlayerIndex = ((game.currentPlayerIndex % total) + total) % total;

            game.messages.push({
                type: 'warning',
                text: `Pemain ${playerId.substring(0, 7)} keluar dari permainan.`
            });
        }
    }

    broadcast(roomCode, {
        type: 'PLAYER_LEFT',
        playerId,
        playerCount: room.players.size,
        playerList: [...room.playerOrder]
    });

    if (room.players.size === 0) {
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} dihapus (kosong).`);
    } else if (room.gameLogicState) {
        broadcastGameState(roomCode);
    }
}

/** Ambil room + identitas pemain yang terikat pada socket ini. */
function getSession(server) {
    const meta = connections.get(server);
    if (!meta) return { meta: null, room: null, playerIndex: -1 };
    const room = rooms.get(meta.roomCode) || null;
    const playerIndex = room ? room.playerOrder.indexOf(meta.playerId) : -1;
    return { meta, room, playerIndex };
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname !== '/websocket') {
            return new Response('Endpoint tidak ditemukan. Gunakan /websocket untuk koneksi game Uno.', {
                status: 404,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }

        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
            return new Response('Expected Upgrade: websocket', { status: 426 });
        }

        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        server.accept();

        server.addEventListener('message', (event) => {
            let message;
            try {
                if (typeof event.data !== 'string' || event.data.length > MAX_WS_MESSAGE_BYTES) {
                    sendError(server, 'Pesan tidak valid.');
                    return;
                }
                message = JSON.parse(event.data);
            } catch {
                sendError(server, 'Format pesan tidak valid.');
                return;
            }

            try {
                handleMessage(server, message, request);
            } catch (err) {
                console.error('Error saat menangani pesan:', err);
                sendError(server, 'Terjadi kesalahan di server.');
            }
        });

        server.addEventListener('close', () => {
            removeSocketFromRoom(server);
        });

        server.addEventListener('error', (event) => {
            console.error('WebSocket error:', event.error ?? event);
            removeSocketFromRoom(server);
        });

        return new Response(null, { status: 101, webSocket: client });
    }
};

// ---------------------------------------------------------------------------
// Penanganan pesan
// ---------------------------------------------------------------------------

function handleMessage(server, message, request) {
    const session = getSession(server);

    switch (message.type) {
        // ---------------------------------------------------------------- ROOM
        case 'CREATE_ROOM': {
            if (session.meta) {
                sendError(server, 'Anda sudah berada di dalam room.');
                return;
            }
            const playerId = sanitizePlayerId(message.playerId);
            if (!playerId) {
                sendError(server, 'playerId tidak valid.');
                return;
            }

            const roomCode = generateUniqueRoomCode();
            rooms.set(roomCode, {
                players: new Map([[playerId, server]]),
                playerOrder: [playerId],
                gameLogicState: null
            });
            connections.set(server, { playerId, roomCode });

            sendTo(server, {
                type: 'ROOM_CREATED',
                roomCode,
                playerId,
                playerCount: 1,
                playerList: [playerId]
            });
            console.log(`Room dibuat: ${roomCode} oleh ${playerId}`);
            return;
        }

        case 'JOIN_ROOM': {
            if (session.meta) {
                sendError(server, 'Anda sudah berada di dalam room.');
                return;
            }
            const playerId = sanitizePlayerId(message.playerId);
            if (!playerId) {
                sendError(server, 'playerId tidak valid.');
                return;
            }
            if (typeof message.roomCode !== 'string' || !message.roomCode.trim()) {
                sendError(server, 'Kode room tidak boleh kosong.');
                return;
            }

            const roomCodeToJoin = message.roomCode.trim().toUpperCase();
            const room = rooms.get(roomCodeToJoin);
            if (!room) {
                sendError(server, 'Kode room tidak ditemukan.');
                return;
            }
            if (room.gameLogicState) {
                sendError(server, 'Game di room ini sedang berjalan. Tunggu hingga selesai.');
                return;
            }
            if (room.players.has(playerId)) {
                sendError(server, 'Pemain dengan ID ini sudah ada di room.');
                return;
            }
            if (room.players.size >= MAX_PLAYERS) {
                sendError(server, `Room sudah penuh (maks ${MAX_PLAYERS} pemain).`);
                return;
            }

            room.players.set(playerId, server);
            room.playerOrder.push(playerId);
            connections.set(server, { playerId, roomCode: roomCodeToJoin });

            sendTo(server, {
                type: 'ROOM_JOINED',
                roomCode: roomCodeToJoin,
                playerId,
                playerCount: room.players.size,
                playerList: [...room.playerOrder]
            });
            broadcast(roomCodeToJoin, {
                type: 'PLAYER_JOINED',
                playerId,
                playerCount: room.players.size,
                playerList: [...room.playerOrder]
            }, playerId);

            console.log(`${playerId} bergabung ke room ${roomCodeToJoin} (${room.players.size} pemain).`);
            return;
        }

        case 'LEAVE_ROOM': {
            if (!session.meta) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            removeSocketFromRoom(server);
            return;
        }

        case 'START_GAME': {
            if (!session.room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (session.room.gameLogicState) {
                sendError(server, 'Game sudah berjalan.');
                return;
            }
            if (session.room.players.size < MIN_PLAYERS) {
                sendError(server, `Butuh minimal ${MIN_PLAYERS} pemain untuk memulai.`);
                return;
            }
            startGame(session.meta.roomCode);
            return;
        }

        // ---------------------------------------------------------------- GAME
        case 'DRAW_CARD': {
            // Identitas diambil dari koneksi, BUKAN dari message.playerId (anti-impersonasi).
            const { meta, room, playerIndex } = getSession(server);
            if (!meta || !room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!room.gameLogicState) {
                sendError(server, 'Game belum dimulai.');
                return;
            }
            if (playerIndex === -1 || room.gameLogicState.currentPlayerIndex !== playerIndex) {
                sendError(server, 'Bukan giliran Anda.');
                return;
            }

            const updated = playerDrawsCard(room.gameLogicState, playerIndex, true);
            if (!updated) {
                sendError(server, 'Tidak dapat mengambil kartu (dek habis).');
                return;
            }
            broadcastGameState(meta.roomCode);
            return;
        }

        case 'PLAY_CARD': {
            const { meta, room, playerIndex } = getSession(server);
            if (!meta || !room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!room.gameLogicState) {
                sendError(server, 'Game belum dimulai.');
                return;
            }
            if (playerIndex === -1 || room.gameLogicState.currentPlayerIndex !== playerIndex) {
                sendError(server, 'Bukan giliran Anda.');
                return;
            }

            const card = sanitizeCard(message.card);
            if (!card) {
                sendError(server, 'Data kartu tidak valid.');
                return;
            }

            let chosenColor = null;
            if (card.color === 'WILD') {
                chosenColor = typeof message.chosenColor === 'string' ? message.chosenColor.toUpperCase() : null;
                if (!UNO_COLORS.includes(chosenColor)) {
                    sendError(server, 'Warna pilihan tidak valid untuk kartu Wild.');
                    return;
                }
            }

            const updated = playCard(room.gameLogicState, playerIndex, card, chosenColor);
            if (!updated) {
                sendError(server, 'Kartu tidak valid untuk dimainkan.');
                return;
            }

            // Peringatan UNO
            if (updated.players[playerIndex].length === 1) {
                updated.messages.push({
                    type: 'warning',
                    text: `Pemain ${playerIndex + 1} tinggal 1 kartu — UNO!`
                });
            }

            broadcastGameState(meta.roomCode);

            if (updated.players[playerIndex].length === 0) {
                endGame(meta.roomCode, playerIndex);
            }
            return;
        }

        default:
            console.warn('Tipe pesan tidak dikenal:', message?.type);
            sendError(server, 'Tipe pesan tidak dikenal.');
    }
}
