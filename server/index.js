// Struktur data untuk menyimpan informasi game rooms.
// Dalam aplikasi produksi, ini mungkin akan menggunakan Durable Objects atau database.
const rooms = new Map(); // Map: roomId -> { players: Map<playerId, WebSocket>, gameLogicState: {} }

/**
 * Fungsi untuk menggenerate kode room unik.
 * Untuk produksi, pastikan ini cukup acak dan tidak mudah ditebak.
 */
function generateUniqueRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 7).toUpperCase(); // Contoh: 5 karakter alfanumerik
    } while (rooms.has(code));
    return code;
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
            // Periksa header 'Upgrade' untuk memastikan ini adalah permintaan WebSocket.
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                return new Response('Expected Upgrade: websocket', { status: 426 });
            }

            // Buat pasangan WebSocket. 'client' adalah untuk klien, 'server' adalah untuk Worker.
            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);

            // Accept koneksi WebSocket di sisi server.
            server.accept();

            // Tambahkan event listener untuk pesan dari klien
            server.addEventListener('message', async event => {
                try {
                    const message = JSON.parse(event.data);
                    console.log('Pesan diterima dari klien:', message);

                    switch (message.type) {
                        case 'CREATE_ROOM':
                            const newRoomCode = generateUniqueRoomCode();
                            rooms.set(newRoomCode, {
                                players: new Map([[message.playerId, server]]), // Simpan WebSocket koneksi
                                gameLogicState: null, // Placeholder untuk state game Uno
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
                                // Cek apakah room belum penuh (misalnya, maks 4 pemain)
                                if (room.players.size < 4) { // Contoh batasan
                                    room.players.set(message.playerId, server);
                                    server.send(JSON.stringify({
                                        type: 'ROOM_JOINED',
                                        roomCode: roomCodeToJoin,
                                        playerId: message.playerId,
                                        playerCount: room.players.size
                                    }));
                                    console.log(`Pemain ${message.playerId} bergabung ke room: ${roomCodeToJoin}`);

                                    // Beri tahu semua pemain lain di room bahwa pemain baru telah bergabung
                                    room.players.forEach((playerWs, pId) => {
                                        if (pId !== message.playerId) {
                                            playerWs.send(JSON.stringify({
                                                type: 'PLAYER_JOINED',
                                                playerId: message.playerId,
                                                playerCount: room.players.size
                                            }));
                                        }
                                    });

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

                        // Di sini nanti akan ada 'PLAY_CARD', 'DRAW_CARD', dll.
                        default:
                            console.warn('Tipe pesan tidak dikenal:', message.type);
                            server.send(JSON.stringify({ type: 'ERROR', message: 'Tipe pesan tidak dikenal.' }));
                    }
                } catch (error) {
                    console.error('Gagal memparsing pesan WebSocket atau error saat penanganan:', error);
                    server.send(JSON.stringify({ type: 'ERROR', message: 'Pesan tidak valid atau error server.' }));
                }
            });

            // Tambahkan event listener untuk koneksi WebSocket yang ditutup
            server.addEventListener('close', event => {
                console.log(`WebSocket ditutup. Kode: ${event.code}, Alasan: ${event.reason}`);
                // Anda perlu logika di sini untuk menghapus pemain dari room jika koneksi ditutup
                // Iterasi melalui rooms untuk menemukan pemain yang terputus
                rooms.forEach((room, roomCode) => {
                    let playerRemoved = false;
                    for (const [playerId, playerWs] of room.players.entries()) {
                        if (playerWs === server) { // Bandingkan objek WebSocket
                            room.players.delete(playerId);
                            playerRemoved = true;
                            console.log(`Pemain ${playerId} terputus dari room ${roomCode}. Sisa pemain: ${room.players.size}`);

                            // Beri tahu pemain lain di room bahwa pemain ini telah pergi
                            room.players.forEach(pWs => {
                                pWs.send(JSON.stringify({
                                    type: 'PLAYER_LEFT',
                                    playerId: playerId,
                                    playerCount: room.players.size
                                }));
                            });

                            // Jika room kosong, hapus room
                            if (room.players.size === 0) {
                                rooms.delete(roomCode);
                                console.log(`Room ${roomCode} dihapus karena kosong.`);
                            }
                            break; // Keluar dari loop setelah menemukan pemain
                        }
                    }
                });
            });

            // Tambahkan event listener untuk error WebSocket
            server.addEventListener('error', event => {
                console.error('WebSocket Error:', event.error);
            });

            // Beri tahu klien bahwa koneksi WebSocket telah berhasil di-upgrade
            return new Response(null, { status: 101, webSocket: client });
        }

        // Untuk permintaan non-WebSocket, berikan respons HTTP standar
        return new Response('Akses /websocket untuk koneksi game Uno.', {
            headers: { 'Content-Type': 'text/plain' },
            status: 404
        });
    },
};
