// server/index.js

// Import logika game Uno
import { initializeGame, createDeck, shuffleDeck, isValidPlay, playCard, playerDrawsCard, applyCardEffect, moveToNextPlayer } from '../shared/uno-logic.js';

// Struktur data untuk menyimpan informasi game rooms.
// Dalam aplikasi produksi, ini mungkin akan menggunakan Durable Objects atau database.
// Untuk demo awal ini, kita gunakan Map.
const rooms = new Map(); // Map: roomId -> { players: Map<playerId, WebSocket>, gameLogicState: {} }

/**
 * Fungsi untuk menggenerate kode room unik.
 */
function generateUniqueRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 7).toUpperCase(); // Contoh: 5 karakter alfanumerik
    } while (rooms.has(code));
    return code;
}

/**
 * Mengirim pesan JSON ke semua pemain di dalam room.
 * @param {string} roomCode - Kode room.
 * @param {object} message - Objek pesan yang akan dikirim (akan di-JSON.stringify).
 */
function broadcastToRoom(roomCode, message) {
    const room = rooms.get(roomCode);
    if (room && room.players) {
        room.players.forEach(playerWs => {
            try {
                playerWs.send(JSON.stringify(message));
            } catch (e) {
                console.error(`Gagal mengirim pesan ke pemain di room ${roomCode}:`, e);
            }
        });
    }
}

/**
 * Ini adalah entry point untuk Cloudflare Worker/Function Anda.
 * Fungsi 'fetch' akan dipanggil setiap kali ada permintaan HTTP masuk.
 */
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Jika permintaan adalah untuk endpoint WebSocket, tangani sebagai WebSocket
        if (url.pathname === '/websocket') {
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                return new Response('Expected Upgrade: websocket', { status: 426 });
            }

            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);

            server.accept();

            server.addEventListener('message', async event => {
                try {
                    const message = JSON.parse(event.data);
                    console.log('Pesan diterima dari klien:', message);

                    switch (message.type) {
                        case 'CREATE_ROOM':
                            const newRoomCode = generateUniqueRoomCode();
                            rooms.set(newRoomCode, {
                                players: new Map([[message.playerId, server]]),
                                gameLogicState: null,
                                playerOrder: [message.playerId] // Melacak urutan pemain
                            });
                            server.send(JSON.stringify({
                                type: 'ROOM_CREATED',
                                roomCode: newRoomCode,
                                playerId: message.playerId
                            }));
                            console.log(`Room baru dibuat: ${newRoomCode} oleh pemain ${message.playerId}`);
                            break;

                        case 'JOIN_ROOM':
                            const roomCodeToJoin = message.roomCode.toUpperCase();
                            if (rooms.has(roomCodeToJoin)) {
                                const room = rooms.get(roomCodeToJoin);
                                if (room.players.size < 10) { // Max 10 players
                                    room.players.set(message.playerId, server);
                                    room.playerOrder.push(message.playerId); // Tambahkan ke urutan pemain
                                    server.send(JSON.stringify({
                                        type: 'ROOM_JOINED',
                                        roomCode: roomCodeToJoin,
                                        playerId: message.playerId,
                                        playerCount: room.players.size,
                                        playerList: Array.from(room.playerOrder) // Kirim daftar pemain
                                    }));
                                    console.log(`Pemain ${message.playerId} bergabung ke room: ${roomCodeToJoin}`);

                                    // Beri tahu semua pemain lain di room bahwa pemain baru telah bergabung
                                    broadcastToRoom(roomCodeToJoin, {
                                        type: 'PLAYER_JOINED',
                                        playerId: message.playerId,
                                        playerCount: room.players.size,
                                        playerList: Array.from(room.playerOrder)
                                    });

                                    // Jika sudah cukup pemain, otomatis mulai game (contoh: min 2 pemain)
                                    if (room.players.size >= 2 && !room.gameLogicState) {
                                        startGame(roomCodeToJoin);
                                    }

                                } else {
                                    server.send(JSON.stringify({
                                        type: 'ERROR',
                                        message: 'Room sudah penuh.'
                                    }));
                                }
                            } else {
                                server.send(JSON.stringify({
                                    type: 'ERROR',
                                    message: 'Kode room tidak valid.'
                                }));
                            }
                            break;

                        case 'DRAW_CARD':
                            if (currentRoomCode && rooms.has(message.roomCode)) {
                                const room = rooms.get(message.roomCode);
                                // Periksa apakah giliran pemain yang meminta draw
                                const localPlayerIndex = room.playerOrder.indexOf(message.playerId);
                                if (room.gameLogicState && room.gameLogicState.currentPlayerIndex === localPlayerIndex) {
                                    const updatedState = playerDrawsCard(room.gameLogicState, localPlayerIndex, true); // Ambil kartu & akhiri giliran
                                    if (updatedState) {
                                        room.gameLogicState = updatedState;
                                        broadcastGameState(message.roomCode);
                                    } else {
                                        server.send(JSON.stringify({ type: 'ERROR', message: 'Tidak dapat mengambil kartu.' }));
                                    }
                                } else {
                                    server.send(JSON.stringify({ type: 'ERROR', message: 'Bukan giliran Anda untuk mengambil kartu.' }));
                                }
                            }
                            break;

                        case 'PLAY_CARD':
                            // Implementasi logika main kartu
                            if (currentRoomCode && rooms.has(message.roomCode)) {
                                const room = rooms.get(message.roomCode);
                                const localPlayerIndex = room.playerOrder.indexOf(message.playerId);

                                if (room.gameLogicState && room.gameLogicState.currentPlayerIndex === localPlayerIndex) {
                                    const cardToPlay = message.card;
                                    const chosenColor = message.chosenColor; // Untuk kartu WILD

                                    const updatedState = playCard(room.gameLogicState, localPlayerIndex, cardToPlay, chosenColor);
                                    if (updatedState) {
                                        room.gameLogicState = updatedState;
                                        broadcastGameState(message.roomCode);
                                    } else {
                                        server.send(JSON.stringify({ type: 'ERROR', message: 'Kartu tidak valid untuk dimainkan.' }));
                                    }
                                } else {
                                    server.send(JSON.stringify({ type: 'ERROR', message: 'Bukan giliran Anda untuk memainkan kartu.' }));
                                }
                            }
                            break;

                        default:
                            console.warn('Tipe pesan tidak dikenal:', message.type);
                            server.send(JSON.stringify({ type: 'ERROR', message: 'Tipe pesan tidak dikenal.' }));
                    }
                } catch (error) {
                    console.error('Gagal memparsing pesan WebSocket atau error saat penanganan:', error);
                    server.send(JSON.stringify({ type: 'ERROR', message: 'Pesan tidak valid atau error server.' }));
                }
            });

            server.addEventListener('close', event => {
                console.log(`WebSocket ditutup. Kode: ${event.code}, Alasan: ${event.reason}`);
                // Temukan dan hapus pemain dari room
                rooms.forEach((room, roomCode) => {
                    let playerRemovedId = null;
                    for (const [playerId, playerWs] of room.players.entries()) {
                        if (playerWs === server) {
                            room.players.delete(playerId);
                            playerRemovedId = playerId;
                            // Hapus juga dari playerOrder
                            room.playerOrder = room.playerOrder.filter(id => id !== playerId);
                            console.log(`Pemain ${playerId} terputus dari room ${roomCode}. Sisa pemain: ${room.players.size}`);
                            break;
                        }
                    }

                    if (playerRemovedId) {
                        // Beri tahu pemain lain di room
                        broadcastToRoom(roomCode, {
                            type: 'PLAYER_LEFT',
                            playerId: playerRemovedId,
                            playerCount: room.players.size,
                            playerList: Array.from(room.playerOrder)
                        });

                        // Jika room kosong setelah pemain pergi
                        if (room.players.size === 0) {
                            rooms.delete(roomCode);
                            console.log(`Room ${roomCode} dihapus karena kosong.`);
                        } else {
                            // Jika game sedang berjalan dan pemain yang keluar adalah pemain saat ini, pindah giliran
                            if (room.gameLogicState && room.gameLogicState.currentPlayerIndex !== undefined) {
                                // Perlu menyesuaikan currentPlayerIndex jika pemain yang keluar adalah yang sedang giliran
                                // Ini bisa menjadi lebih kompleks, untuk saat ini, kita biarkan saja.
                                // Idealnya, logika game harus diupdate untuk menyesuaikan indeks setelah pemain keluar.
                                // Untuk sederhana: hanya kirim update state
                                broadcastGameState(roomCode);
                            }
                        }
                    }
                });
            });

            server.addEventListener('error', event => {
                console.error('WebSocket Error:', event.error);
            });

            return new Response(null, { status: 101, webSocket: client });
        }

        return new Response('Akses /websocket untuk koneksi game Uno.', {
            headers: { 'Content-Type': 'text/plain' },
            status: 404
        });
    },
};

/**
 * Memulai game Uno di room tertentu.
 * @param {string} roomCode - Kode room yang akan memulai game.
 */
function startGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const numPlayers = room.players.size;
    console.log(`Memulai game untuk room ${roomCode} dengan ${numPlayers} pemain.`);

    const initialGameState = initializeGame(numPlayers); // Inisialisasi game dari uno-logic.js
    if (initialGameState) {
        room.gameLogicState = initialGameState;

        // Mendistribusikan tangan setiap pemain secara spesifik ke masing-masing klien
        room.playerOrder.forEach((playerId, index) => {
            const playerWs = room.players.get(playerId);
            if (playerWs) {
                playerWs.send(JSON.stringify({
                    type: 'GAME_STATE_UPDATE',
                    gameState: {
                        ...room.gameLogicState,
                        playerHand: room.gameLogicState.players[index], // Kirim hanya tangan pemain ini
                        players: room.gameLogicState.players.map(hand => ({ count: hand.length })) // Kirim hanya jumlah kartu pemain lain
                    }
                }));
            }
        });

        // Kirim update awal ke semua pemain tentang discard pile, giliran, dll.
        // Tanpa mengirimkan semua tangan pemain.
        broadcastToRoom(roomCode, {
            type: 'GAME_STARTED',
            message: `Game dimulai dengan ${numPlayers} pemain!`,
            initialState: {
                discardPile: room.gameLogicState.discardPile,
                lastPlayedCard: room.gameLogicState.lastPlayedCard,
                currentColor: room.gameLogicState.currentColor,
                currentPlayerIndex: room.gameLogicState.currentPlayerIndex,
                direction: room.gameLogicState.direction,
                players: room.gameLogicState.players.map(hand => ({ count: hand.length })) // Hanya jumlah kartu
            }
        });
    } else {
        console.error(`Gagal menginisialisasi game untuk room ${roomCode}.`);
        broadcastToRoom(roomCode, { type: 'ERROR', message: 'Gagal memulai game Uno.' });
    }
}

/**
 * Mengirimkan state game saat ini (tanpa detail tangan pemain lain) ke semua klien di room.
 * @param {string} roomCode - Kode room.
 */
function broadcastGameState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.gameLogicState) return;

    room.playerOrder.forEach((playerId, index) => {
        const playerWs = room.players.get(playerId);
        if (playerWs) {
            // Kirim state game lengkap, tetapi tangan pemain lain hanya sebagai jumlah kartu
            const stateToSend = {
                ...room.gameLogicState,
                playerHand: room.gameLogicState.players[index], // Tangan pemain ini lengkap
                players: room.gameLogicState.players.map(hand => ({ count: hand.length })) // Tangan pemain lain hanya jumlahnya
            };
            playerWs.send(JSON.stringify({
                type: 'GAME_STATE_UPDATE',
                gameState: stateToSend
            }));
        }
    });
}
