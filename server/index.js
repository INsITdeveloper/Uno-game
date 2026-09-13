// server/index.js
// Cloudflare Worker: WebSocket, profil pemain, matchmaking, lawan bot, dan
// otorisasi seluruh aksi permainan.
//
// PRINSIP: server adalah satu-satunya sumber kebenaran.
// Klien hanya menyampaikan niat ("saya mau main kartu X"); server yang memutuskan.

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
import { chooseBotAction, randomBotIdentity } from '../shared/uno-bot.js';

/**
 * @typedef {Object} Member
 * @property {string} id
 * @property {WebSocket|null} ws   null = bot
 * @property {string} name
 * @property {string} avatar
 * @property {boolean} isBot
 *
 * @typedef {Object} Room
 * @property {string} code
 * @property {Map<string, Member>} members
 * @property {string[]} order          urutan giliran; indeks sejajar dengan game.players
 * @property {string} hostId
 * @property {'private'|'matchmaking'} mode
 * @property {object|null} game
 * @property {ReturnType<typeof setTimeout>|null} botTimer
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

/** Identitas pemain terikat ke koneksi (bukan dari message.playerId). @type {Map<WebSocket, {playerId: string, roomCode: string}>} */
const connections = new Map();

/** Antrean matchmaking. @type {Array<{ws: WebSocket, playerId: string, name: string, avatar: string, timer: any}>} */
const queue = [];

const VALID_CARD_COLORS = new Set([...UNO_COLORS, 'WILD']);
const VALID_CARD_TYPES = new Set([...UNO_NUMBERS, ...UNO_ACTION_CARDS, ...UNO_WILD_CARDS]);
const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const AVATAR_PATTERN = /^(a(0[1-9]|1[0-4])|fallback)$/;
const MAX_WS_MESSAGE_BYTES = 8 * 1024;
// Avatar hasil upload hanya boleh berasal dari CDN INS (allow-list).
// Tanpa ini, pemain bisa menempelkan URL sembarang yang dilihat pemain lain.
const AVATAR_URL_HOSTS = new Set(['cloudins-cdn.insjay.biz.id', 'cdnins.insjay.biz.id']);
const MAX_AVATAR_URL_LENGTH = 400;
const MAX_BOTS = 3;
const MAX_NAME_LENGTH = 16;
const MATCH_BOT_FALLBACK_MS = 7000;
const BOT_THINK_MIN_MS = 700;
const BOT_THINK_MAX_MS = 1400;

// ---------------------------------------------------------------------------
// Helper umum
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
    if (!ws) return;
    try {
        ws.send(JSON.stringify(message));
    } catch (err) {
        console.error('Gagal mengirim pesan WebSocket:', err);
    }
}

function sendError(ws, message) {
    sendTo(ws, { type: 'ERROR', message });
}

function sanitizePlayerId(raw) {
    return typeof raw === 'string' && PLAYER_ID_PATTERN.test(raw) ? raw : null;
}

function sanitizeName(raw) {
    if (typeof raw !== 'string') return null;
    // buang karakter kontrol & rapikan spasi
    const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (clean.length < 1 || clean.length > MAX_NAME_LENGTH) return null;
    return clean;
}

function sanitizeAvatar(raw) {
    return typeof raw === 'string' && AVATAR_PATTERN.test(raw) ? raw : 'fallback';
}

function sanitizeAvatarUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_AVATAR_URL_LENGTH) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:') return null;
    if (!AVATAR_URL_HOSTS.has(parsed.hostname)) return null;
    return parsed.toString();
}

function sanitizeProfile(raw) {
    const profile = raw && typeof raw === 'object' ? raw : {};
    return {
        name: sanitizeName(profile.name) || 'Pemain',
        avatar: sanitizeAvatar(profile.avatar),
        avatarUrl: sanitizeAvatarUrl(profile.avatarUrl)
    };
}

function sanitizeCard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const { color, type } = raw;
    if (typeof color !== 'string' || typeof type !== 'string') return null;
    if (!VALID_CARD_COLORS.has(color) || !VALID_CARD_TYPES.has(type)) return null;
    return { color, type };
}

/** Ringkasan pemain untuk dikirim ke klien (tanpa data internal). */
function publicPlayers(room) {
    return room.order.map((id) => {
        const m = room.members.get(id);
        return m
            ? { id: m.id, name: m.name, avatar: m.avatar, avatarUrl: m.avatarUrl, isBot: m.isBot }
            : { id, name: '?', avatar: 'fallback', avatarUrl: null, isBot: false };
    });
}

function broadcast(roomCode, message, excludePlayerId = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    for (const [playerId, m] of room.members) {
        if (excludePlayerId && playerId === excludePlayerId) continue;
        sendTo(m.ws, message);
    }
}

function broadcastLobby(roomCode) {
    broadcast(roomCode, {
        type: 'ROOM_UPDATE',
        roomCode,
        hostId: rooms.get(roomCode)?.hostId ?? null,
        playerList: publicPlayers(rooms.get(roomCode))
    });
}

function stopBotTimer(room) {
    if (room && room.botTimer) {
        clearTimeout(room.botTimer);
        room.botTimer = null;
    }
}

// ---------------------------------------------------------------------------
// Room & keanggotaan
// ---------------------------------------------------------------------------

function createRoom(mode, hostId) {
    let code = generateUniqueRoomCode();
    const room = {
        code,
        members: new Map(),
        order: [],
        hostId: hostId ?? null,
        mode,
        game: null,
        botTimer: null
    };
    rooms.set(code, room);
    return room;
}

function addHuman(room, playerId, ws, profile) {
    room.members.set(playerId, {
        id: playerId,
        ws,
        name: profile.name,
        avatar: profile.avatar,
        avatarUrl: profile.avatarUrl || null,
        isBot: false
    });
    room.order.push(playerId);
    connections.set(ws, { playerId, roomCode: room.code });
}

function addBot(room) {
    const taken = [...room.members.values()].map((m) => m.name);
    const identity = randomBotIdentity(Math.random, taken);
    const botId = 'bot_' + Math.random().toString(36).substring(2, 9);
    room.members.set(botId, {
        id: botId,
        ws: null,
        name: identity.name,
        avatar: identity.avatar,
        avatarUrl: null,
        isBot: true
    });
    room.order.push(botId);
    return botId;
}

function promoteHostIfNeeded(room) {
    if (room.hostId && room.members.has(room.hostId)) return;
    const next = room.order.find((id) => !room.members.get(id)?.isBot);
    room.hostId = next ?? null;
}

function isHost(room, playerId) {
    return room.hostId === playerId;
}

// ---------------------------------------------------------------------------
// State game
// ---------------------------------------------------------------------------

function buildStateFor(room, index, pendingMessages) {
    const game = room.game;
    return {
        playerHand: game.players[index],
        players: game.players.map((hand, i) => {
            const id = room.order[i];
            const m = room.members.get(id);
            return {
                id,
                name: m ? m.name : '?',
                avatar: m ? m.avatar : 'fallback',
                avatarUrl: m ? m.avatarUrl : null,
                isBot: Boolean(m && m.isBot),
                count: hand.length,
                isYou: i === index
            };
        }),
        discardPile: game.discardPile,
        lastPlayedCard: game.lastPlayedCard,
        currentColor: game.currentColor,
        currentPlayerIndex: game.currentPlayerIndex,
        currentPlayerId: room.order[game.currentPlayerIndex] ?? null,
        direction: game.direction,
        pendingDraw: game.pendingDraw,
        deckCount: game.deck.length,
        winner: game.winner,
        messages: pendingMessages
    };
}

/** Kirim state ke semua pemain manusia. Antrean pesan di-drain sekali. */
function broadcastGameState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.game) return;

    const pending = room.game.messages.splice(0);

    room.order.forEach((playerId, index) => {
        const m = room.members.get(playerId);
        if (!m || !m.ws) return; // bot tidak dikirimi apa pun
        sendTo(m.ws, {
            type: 'GAME_STATE_UPDATE',
            gameState: buildStateFor(room, index, pending)
        });
    });
}

function startGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const numPlayers = room.order.length;
    if (numPlayers < MIN_PLAYERS || numPlayers > MAX_PLAYERS) {
        broadcast(roomCode, { type: 'ERROR', message: `Butuh ${MIN_PLAYERS}-${MAX_PLAYERS} pemain.` });
        return;
    }

    const state = initializeGame(numPlayers);
    if (!state) {
        broadcast(roomCode, { type: 'ERROR', message: 'Gagal menginisialisasi game.' });
        return;
    }

    room.game = state;
    console.log(`Room ${room.code}: game dimulai dengan ${numPlayers} pemain (${room.mode}).`);

    broadcast(roomCode, {
        type: 'GAME_STARTED',
        message: `Game dimulai — ${numPlayers} pemain.`
    });
    broadcastGameState(roomCode);
    maybeRunBots(roomCode);
}

function endGame(roomCode, winnerIndex) {
    const room = rooms.get(roomCode);
    if (!room || !room.game) return;

    stopBotTimer(room);
    const winnerId = room.order[winnerIndex] ?? null;
    const winner = room.members.get(winnerId);
    room.game.winner = winnerIndex;

    broadcast(roomCode, {
        type: 'GAME_OVER',
        winnerId,
        winnerName: winner ? winner.name : '?',
        isBot: Boolean(winner && winner.isBot),
        message: `${winner ? winner.name : '?'} menang!`
    });

    // Room tetap hidup supaya bisa main lagi / pemain baru masuk.
    room.game = null;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

function maybeRunBots(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.game || room.game.winner !== null) return;
    if (room.botTimer) return;

    const currentId = room.order[room.game.currentPlayerIndex];
    const member = room.members.get(currentId);
    if (!member || !member.isBot) return;

    const delay = BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
    room.botTimer = setTimeout(() => {
        room.botTimer = null;
        runBotTurn(roomCode);
    }, delay);
}

function runBotTurn(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.game || room.game.winner !== null) return;

    const index = room.game.currentPlayerIndex;
    const botId = room.order[index];
    const member = room.members.get(botId);
    if (!member || !member.isBot) return;

    const action = chooseBotAction(room.game, index);

    if (action.kind === 'play') {
        const updated = playCard(room.game, index, action.card, action.chosenColor);
        if (!updated) {
            // Jaring pengaman: kalau bot memilih kartu tak valid, ambil kartu saja.
            playerDrawsCard(room.game, index, true);
            broadcastGameState(roomCode);
            maybeRunBots(roomCode);
            return;
        }

        if (updated.players[index].length === 1) {
            updated.messages.push({ type: 'warning', text: `${member.name} tinggal 1 kartu — UNO!` });
        }
        broadcastGameState(roomCode);

        if (updated.players[index].length === 0) {
            endGame(roomCode, index);
            return;
        }
    } else {
        playerDrawsCard(room.game, index, true);
        broadcastGameState(roomCode);
    }

    maybeRunBots(roomCode);
}

// ---------------------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------------------

function dequeue(entry) {
    const i = queue.indexOf(entry);
    if (i !== -1) queue.splice(i, 1);
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    return i !== -1;
}

function notifyMatchFound(room, entries) {
    const payload = {
        type: 'MATCH_FOUND',
        roomCode: room.code,
        hostId: room.hostId,
        playerList: publicPlayers(room)
    };
    for (const entry of entries) sendTo(entry.ws, payload);
}

function tryMatch() {
    while (queue.length >= 2) {
        // Pilih dua pemain acak (bukan selalu pasangan pertama)
        const a = queue.splice(Math.floor(Math.random() * queue.length), 1)[0];
        const b = queue.splice(Math.floor(Math.random() * queue.length), 1)[0];
        dequeue(a);
        dequeue(b);

        const room = createRoom('matchmaking', a.playerId);
        addHuman(room, a.playerId, a.ws, { name: a.name, avatar: a.avatar, avatarUrl: a.avatarUrl });
        addHuman(room, b.playerId, b.ws, { name: b.name, avatar: b.avatar, avatarUrl: b.avatarUrl });
        notifyMatchFound(room, [a, b]);
        startGame(room.code);
    }
}

/** Kalau tidak ada manusia lain dalam batas waktu, isi dengan bot. */
function pairWithBot(entry) {
    if (!dequeue(entry)) return;
    const room = createRoom('matchmaking', entry.playerId);
    addHuman(room, entry.playerId, entry.ws, {
        name: entry.name,
        avatar: entry.avatar,
        avatarUrl: entry.avatarUrl
    });
    addBot(room);
    notifyMatchFound(room, [entry]);
    sendTo(entry.ws, { type: 'MATCH_BOT_FILLED', message: 'Belum ada pemain lain — kamu dilawankan dengan bot.' });
    startGame(room.code);
}

function enqueueMatchmaking(ws, playerId, profile) {
    const entry = {
        ws,
        playerId,
        name: profile.name,
        avatar: profile.avatar,
        avatarUrl: profile.avatarUrl,
        timer: null
    };
    queue.push(entry);
    sendTo(ws, { type: 'MATCH_SEARCHING', message: 'Mencari pemain lain...' });

    entry.timer = setTimeout(() => {
        entry.timer = null;
        pairWithBot(entry);
    }, MATCH_BOT_FALLBACK_MS);

    tryMatch();
}

// ---------------------------------------------------------------------------
// Keluar room / koneksi putus
// ---------------------------------------------------------------------------

function removeSocketFromRoom(server) {
    const meta = connections.get(server);
    if (!meta) return;

    connections.delete(server);

    // Kalau sedang antre matchmaking, cabut dari antrean
    const queued = queue.find((e) => e.ws === server);
    if (queued) dequeue(queued);

    const room = rooms.get(meta.roomCode);
    if (!room) return;
    if (room.members.get(meta.playerId)?.ws !== server) return;

    const orderIndex = room.order.indexOf(meta.playerId);
    room.members.delete(meta.playerId);
    if (orderIndex !== -1) room.order.splice(orderIndex, 1);

    if (room.game && orderIndex !== -1) {
        const game = room.game;
        if (orderIndex < game.players.length) game.players.splice(orderIndex, 1);

        if (game.players.length < MIN_PLAYERS) {
            stopBotTimer(room);
            room.game = null;
            broadcast(room.code, {
                type: 'GAME_ABORTED',
                message: 'Game dihentikan karena pemain tidak cukup.'
            });
        } else {
            const before = game.currentPlayerIndex;
            if (orderIndex === before) {
                game.currentPlayerIndex = orderIndex + (game.direction === -1 ? -1 : 0);
            } else if (orderIndex < before) {
                game.currentPlayerIndex = before - 1;
            }
            const total = game.players.length;
            game.currentPlayerIndex = ((game.currentPlayerIndex % total) + total) % total;
        }
    }

    promoteHostIfNeeded(room);

    broadcast(room.code, {
        type: 'PLAYER_LEFT',
        playerId: meta.playerId,
        playerList: publicPlayers(room)
    });

    const humansLeft = room.order.filter((id) => !room.members.get(id)?.isBot).length;
    if (humansLeft === 0) {
        stopBotTimer(room);
        rooms.delete(room.code);
        console.log(`Room ${room.code} dihapus (tidak ada pemain manusia).`);
        return;
    }

    if (room.game) {
        broadcastGameState(room.code);
        maybeRunBots(room.code);
    } else {
        broadcastLobby(room.code);
    }
}

/** Sesi: room + identitas yang terikat pada socket. */
function getSession(server) {
    const meta = connections.get(server);
    if (!meta) return { meta: null, room: null, playerIndex: -1 };
    const room = rooms.get(meta.roomCode) || null;
    const playerIndex = room ? room.order.indexOf(meta.playerId) : -1;
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
                handleMessage(server, message);
            } catch (err) {
                console.error('Error saat menangani pesan:', err);
                sendError(server, 'Terjadi kesalahan di server.');
            }
        });

        server.addEventListener('close', () => removeSocketFromRoom(server));
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

function handleMessage(server, message) {
    const session = getSession(server);

    switch (message.type) {
        // ------------------------------------------------------------- LOBBY
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

            const profile = sanitizeProfile(message.profile);
            const room = createRoom('private', playerId);
            addHuman(room, playerId, server, profile);

            sendTo(server, {
                type: 'ROOM_CREATED',
                roomCode: room.code,
                playerId,
                hostId: room.hostId,
                playerList: publicPlayers(room)
            });
            console.log(`Room dibuat: ${room.code} oleh ${profile.name} (${playerId})`);
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

            const code = message.roomCode.trim().toUpperCase();
            const room = rooms.get(code);
            if (!room) {
                sendError(server, 'Kode room tidak ditemukan.');
                return;
            }
            if (room.game) {
                sendError(server, 'Game di room ini sedang berjalan.');
                return;
            }
            if (room.members.has(playerId)) {
                sendError(server, 'Pemain dengan ID ini sudah ada di room.');
                return;
            }
            if (room.order.length >= MAX_PLAYERS) {
                sendError(server, `Room sudah penuh (maks ${MAX_PLAYERS} pemain).`);
                return;
            }

            const profile = sanitizeProfile(message.profile);
            addHuman(room, playerId, server, profile);

            sendTo(server, {
                type: 'ROOM_JOINED',
                roomCode: room.code,
                playerId,
                hostId: room.hostId,
                playerList: publicPlayers(room)
            });
            broadcastLobby(room.code);
            console.log(`${profile.name} bergabung ke room ${room.code} (${room.order.length} pemain).`);
            return;
        }

        case 'FIND_MATCH': {
            if (session.meta) {
                sendError(server, 'Anda sudah berada di dalam room.');
                return;
            }
            const playerId = sanitizePlayerId(message.playerId);
            if (!playerId) {
                sendError(server, 'playerId tidak valid.');
                return;
            }
            if (queue.some((e) => e.playerId === playerId)) {
                sendError(server, 'Anda sudah dalam antrean.');
                return;
            }
            enqueueMatchmaking(server, playerId, sanitizeProfile(message.profile));
            return;
        }

        case 'CANCEL_MATCH': {
            const entry = queue.find((e) => e.ws === server);
            if (!entry) {
                sendError(server, 'Anda tidak sedang dalam antrean.');
                return;
            }
            dequeue(entry);
            sendTo(server, { type: 'MATCH_CANCELLED' });
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

        case 'ADD_BOT': {
            const { meta, room } = session;
            if (!meta || !room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!isHost(room, meta.playerId)) {
                sendError(server, 'Hanya pembuat room yang bisa menambah bot.');
                return;
            }
            if (room.game) {
                sendError(server, 'Game sudah berjalan.');
                return;
            }
            const botCount = room.order.filter((id) => room.members.get(id)?.isBot).length;
            if (botCount >= MAX_BOTS) {
                sendError(server, `Maksimal ${MAX_BOTS} bot per room.`);
                return;
            }
            if (room.order.length >= MAX_PLAYERS) {
                sendError(server, `Room sudah penuh (maks ${MAX_PLAYERS} pemain).`);
                return;
            }
            addBot(room);
            broadcastLobby(room.code);
            return;
        }

        case 'REMOVE_BOT': {
            const { meta, room } = session;
            if (!meta || !room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!isHost(room, meta.playerId)) {
                sendError(server, 'Hanya pembuat room yang bisa menghapus bot.');
                return;
            }
            const botId = typeof message.botId === 'string' ? message.botId : '';
            const member = room.members.get(botId);
            if (!member || !member.isBot) {
                sendError(server, 'Bot tidak ditemukan.');
                return;
            }
            room.members.delete(botId);
            room.order = room.order.filter((id) => id !== botId);
            broadcastLobby(room.code);
            return;
        }

        case 'START_GAME': {
            const { meta, room } = session;
            if (!meta || !room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!isHost(room, meta.playerId)) {
                sendError(server, 'Hanya pembuat room yang bisa memulai game.');
                return;
            }
            if (room.game) {
                sendError(server, 'Game sudah berjalan.');
                return;
            }
            if (room.order.length < MIN_PLAYERS) {
                sendError(server, `Butuh minimal ${MIN_PLAYERS} pemain. Tambah bot kalau belum ada lawan.`);
                return;
            }
            startGame(meta.roomCode);
            return;
        }

        // -------------------------------------------------------------- GAME
        case 'DRAW_CARD': {
            const { meta, room, playerIndex } = session;
            if (!meta || !room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!room.game) {
                sendError(server, 'Game belum dimulai.');
                return;
            }
            if (playerIndex === -1 || room.game.currentPlayerIndex !== playerIndex) {
                sendError(server, 'Bukan giliran Anda.');
                return;
            }

            const updated = playerDrawsCard(room.game, playerIndex, true);
            if (!updated) {
                sendError(server, 'Tidak dapat mengambil kartu (dek habis).');
                return;
            }
            broadcastGameState(meta.roomCode);
            maybeRunBots(meta.roomCode);
            return;
        }

        case 'PLAY_CARD': {
            const { meta, room, playerIndex } = session;
            if (!meta || !room) {
                sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!room.game) {
                sendError(server, 'Game belum dimulai.');
                return;
            }
            if (playerIndex === -1 || room.game.currentPlayerIndex !== playerIndex) {
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

            const updated = playCard(room.game, playerIndex, card, chosenColor);
            if (!updated) {
                sendError(server, 'Kartu tidak valid untuk dimainkan.');
                return;
            }

            const me = room.members.get(meta.playerId);
            if (updated.players[playerIndex].length === 1) {
                updated.messages.push({
                    type: 'warning',
                    text: `${me ? me.name : 'Pemain'} tinggal 1 kartu — UNO!`
                });
            }

            broadcastGameState(meta.roomCode);

            if (updated.players[playerIndex].length === 0) {
                endGame(meta.roomCode, playerIndex);
                return;
            }
            maybeRunBots(meta.roomCode);
            return;
        }

        default:
            console.warn('Tipe pesan tidak dikenal:', message?.type);
            sendError(server, 'Tipe pesan tidak dikenal.');
    }
}
