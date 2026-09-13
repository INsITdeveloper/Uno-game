// server/index.js
// Cloudflare Worker: WebSocket, profil pemain, matchmaking, lawan bot, dan
// otorisasi seluruh aksi permainan.
//
// PRINSIP: server adalah satu-satunya sumber kebenaran.
// Klien hanya menyampaikan niat ("saya mau main kartu X"); server yang memutuskan.

import {
    initializeGame,
    playCard,
    playCards,
    validatePlaySet,
    resolvePendingDraw,
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
const MAX_CHAT_LENGTH = 200;

/**
 * Bersihkan teks chat: buang karakter kontrol, rapikan spasi, batasi panjang.
 * @param {unknown} raw
 * @returns {string|null}
 */
function sanitizeChat(raw) {
    if (typeof raw !== 'string') return null;
    const clean = raw
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length < 1) return null;
    return clean.slice(0, MAX_CHAT_LENGTH);
}

// ---------------------------------------------------------------------------
// Durable Object: satu instance memegang SEMUA room.
// Ini yang memperbaiki bug "Kode room tidak ditemukan": sebelumnya state
// disimpan di Map tingkat modul, dan Cloudflare menjalankan Worker di banyak
// isolate sehingga room yang dibuat di satu isolate tidak terlihat di isolate
// lain. Dengan Durable Object, semua koneksi masuk ke instance yang sama.
// ---------------------------------------------------------------------------

export class UnoServer {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.rooms = new Map();
        this.connections = new Map();
        this.queue = [];
    }

    async fetch(request) {
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
                    this.sendError(server, 'Pesan tidak valid.');
                    return;
                }
                message = JSON.parse(event.data);
            } catch {
                this.sendError(server, 'Format pesan tidak valid.');
                return;
            }
            try {
                this.handleMessage(server, message);
            } catch (err) {
                console.error('Error saat menangani pesan:', err);
                this.sendError(server, 'Terjadi kesalahan di server.');
            }
        });

        server.addEventListener('close', () => this.removeSocketFromRoom(server));
        server.addEventListener('error', (event) => {
            console.error('WebSocket error:', event.error ?? event);
            this.removeSocketFromRoom(server);
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    generateUniqueRoomCode() {
        let code;
        let attempts = 0;
        do {
            code = Math.random().toString(36).substring(2, 7).toUpperCase();
            attempts++;
        } while (this.rooms.has(code) && attempts < 100);
        return code;
    }

    sendTo(ws, message) {
        if (!ws) return;
        try {
            ws.send(JSON.stringify(message));
        } catch (err) {
            console.error('Gagal mengirim pesan WebSocket:', err);
        }
    }

    sendError(ws, message) {
        this.sendTo(ws, { type: 'ERROR', message });
    }

    sanitizePlayerId(raw) {
        return typeof raw === 'string' && PLAYER_ID_PATTERN.test(raw) ? raw : null;
    }

    sanitizeName(raw) {
        if (typeof raw !== 'string') return null;
        // buang karakter kontrol & rapikan spasi
        const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
        if (clean.length < 1 || clean.length > MAX_NAME_LENGTH) return null;
        return clean;
    }

    sanitizeAvatar(raw) {
        return typeof raw === 'string' && AVATAR_PATTERN.test(raw) ? raw : 'fallback';
    }

    sanitizeAvatarUrl(raw) {
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

    sanitizeProfile(raw) {
        const profile = raw && typeof raw === 'object' ? raw : {};
        return {
            name: this.sanitizeName(profile.name) || 'Pemain',
            avatar: this.sanitizeAvatar(profile.avatar),
            avatarUrl: this.sanitizeAvatarUrl(profile.avatarUrl)
        };
    }

    sanitizeCard(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const { color, type } = raw;
        if (typeof color !== 'string' || typeof type !== 'string') return null;
        if (!VALID_CARD_COLORS.has(color) || !VALID_CARD_TYPES.has(type)) return null;
        return { color, type };
    }

    publicPlayers(room) {
        return room.order.map((id) => {
            const m = room.members.get(id);
            return m
                ? { id: m.id, name: m.name, avatar: m.avatar, avatarUrl: m.avatarUrl, isBot: m.isBot }
                : { id, name: '?', avatar: 'fallback', avatarUrl: null, isBot: false };
        });
    }

    broadcast(roomCode, message, excludePlayerId = null) {
        const room = this.rooms.get(roomCode);
        if (!room) return;
        for (const [playerId, m] of room.members) {
            if (excludePlayerId && playerId === excludePlayerId) continue;
            this.sendTo(m.ws, message);
        }
    }

    broadcastLobby(roomCode) {
        this.broadcast(roomCode, {
            type: 'ROOM_UPDATE',
            roomCode,
            hostId: this.rooms.get(roomCode)?.hostId ?? null,
            rules: this.rooms.get(roomCode)?.rules ?? null,
            playerList: this.publicPlayers(this.rooms.get(roomCode))
        });
    }

    stopBotTimer(room) {
        if (room && room.botTimer) {
            clearTimeout(room.botTimer);
            room.botTimer = null;
        }
    }

    createRoom(mode, hostId) {
        let code = this.generateUniqueRoomCode();
        const room = {
            code,
            members: new Map(),
            order: [],
            hostId: hostId ?? null,
            mode,
            game: null,
            botTimer: null,
            // Aturan rumahan, ditentukan pembuat room. Default mati.
            rules: { multiPlay: false, stacking: false }
        };
        this.rooms.set(code, room);
        return room;
    }

    addHuman(room, playerId, ws, profile) {
        room.members.set(playerId, {
            id: playerId,
            ws,
            name: profile.name,
            avatar: profile.avatar,
            avatarUrl: profile.avatarUrl || null,
            isBot: false
        });
        room.order.push(playerId);
        this.connections.set(ws, { playerId, roomCode: room.code });
    }

    addBot(room) {
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

    promoteHostIfNeeded(room) {
        if (room.hostId && room.members.has(room.hostId)) return;
        const next = room.order.find((id) => !room.members.get(id)?.isBot);
        room.hostId = next ?? null;
    }

    isHost(room, playerId) {
        return room.hostId === playerId;
    }

    buildStateFor(room, index, pendingMessages) {
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
            rules: game.rules,
            messages: pendingMessages
        };
    }

    broadcastGameState(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room || !room.game) return;

        const pending = room.game.messages.splice(0);

        room.order.forEach((playerId, index) => {
            const m = room.members.get(playerId);
            if (!m || !m.ws) return; // bot tidak dikirimi apa pun
            this.sendTo(m.ws, {
                type: 'GAME_STATE_UPDATE',
                gameState: this.buildStateFor(room, index, pending)
            });
        });
    }

    startGame(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room) return;

        const numPlayers = room.order.length;
        if (numPlayers < MIN_PLAYERS || numPlayers > MAX_PLAYERS) {
            this.broadcast(roomCode, { type: 'ERROR', message: `Butuh ${MIN_PLAYERS}-${MAX_PLAYERS} pemain.` });
            return;
        }

        const state = initializeGame(numPlayers, room.rules);
        if (!state) {
            this.broadcast(roomCode, { type: 'ERROR', message: 'Gagal menginisialisasi game.' });
            return;
        }

        room.game = state;
        console.log(`Room ${room.code}: game dimulai dengan ${numPlayers} pemain (${room.mode}).`);

        this.broadcast(roomCode, {
            type: 'GAME_STARTED',
            message: `Game dimulai — ${numPlayers} pemain.`
        });
        this.broadcastGameState(roomCode);
        this.maybeRunBots(roomCode);
    }

    endGame(roomCode, winnerIndex) {
        const room = this.rooms.get(roomCode);
        if (!room || !room.game) return;

        this.stopBotTimer(room);
        const winnerId = room.order[winnerIndex] ?? null;
        const winner = room.members.get(winnerId);
        room.game.winner = winnerIndex;

        this.broadcast(roomCode, {
            type: 'GAME_OVER',
            winnerId,
            winnerName: winner ? winner.name : '?',
            isBot: Boolean(winner && winner.isBot),
            message: `${winner ? winner.name : '?'} menang!`
        });

        // Room tetap hidup supaya bisa main lagi / pemain baru masuk.
        room.game = null;
    }

    maybeRunBots(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room || !room.game || room.game.winner !== null) return;
        if (room.botTimer) return;

        const currentId = room.order[room.game.currentPlayerIndex];
        const member = room.members.get(currentId);
        if (!member || !member.isBot) return;

        const delay = BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
        room.botTimer = setTimeout(() => {
            room.botTimer = null;
            this.runBotTurn(roomCode);
        }, delay);
    }

    runBotTurn(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room || !room.game || room.game.winner !== null) return;

        const index = room.game.currentPlayerIndex;
        const botId = room.order[index];
        const member = room.members.get(botId);
        if (!member || !member.isBot) return;

        const action = chooseBotAction(room.game, index);

        if (action.kind === 'play') {
            const updated = playCard(room.game, index, action.card, action.chosenColor);
            if (!updated) {
                // Jaring pengaman: kalau bot memilih kartu tak valid, ambil hukuman
                // kalau ada, kalau tidak ambil satu kartu biasa.
                if (room.game.pendingDraw > 0) resolvePendingDraw(room.game, index);
                else playerDrawsCard(room.game, index, true);
                this.broadcastGameState(roomCode);
                this.maybeRunBots(roomCode);
                return;
            }

            if (updated.players[index].length === 1) {
                updated.messages.push({ type: 'warning', text: `${member.name} tinggal 1 kartu — UNO!` });
            }
            this.broadcastGameState(roomCode);

            if (updated.players[index].length === 0) {
                this.endGame(roomCode, index);
                return;
            }
        } else if (room.game.pendingDraw > 0) {
            // Bot memilih menyerah: ambil seluruh hukuman, bukan satu kartu.
            resolvePendingDraw(room.game, index);
            this.broadcastGameState(roomCode);
        } else {
            playerDrawsCard(room.game, index, true);
            this.broadcastGameState(roomCode);
        }

        this.maybeRunBots(roomCode);
    }

    dequeue(entry) {
        const i = this.queue.indexOf(entry);
        if (i !== -1) this.queue.splice(i, 1);
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        return i !== -1;
    }

    notifyMatchFound(room, entries) {
        const payload = {
            type: 'MATCH_FOUND',
            roomCode: room.code,
            hostId: room.hostId,
            playerList: this.publicPlayers(room)
        };
        for (const entry of entries) this.sendTo(entry.ws, payload);
    }

    tryMatch() {
        while (this.queue.length >= 2) {
            // Pilih dua pemain acak (bukan selalu pasangan pertama)
            const a = this.queue.splice(Math.floor(Math.random() * this.queue.length), 1)[0];
            const b = this.queue.splice(Math.floor(Math.random() * this.queue.length), 1)[0];
            this.dequeue(a);
            this.dequeue(b);

            const room = this.createRoom('matchmaking', a.playerId);
            this.addHuman(room, a.playerId, a.ws, { name: a.name, avatar: a.avatar, avatarUrl: a.avatarUrl });
            this.addHuman(room, b.playerId, b.ws, { name: b.name, avatar: b.avatar, avatarUrl: b.avatarUrl });
            this.notifyMatchFound(room, [a, b]);
            this.startGame(room.code);
        }
    }

    pairWithBot(entry) {
        if (!this.dequeue(entry)) return;
        const room = this.createRoom('matchmaking', entry.playerId);
        this.addHuman(room, entry.playerId, entry.ws, {
            name: entry.name,
            avatar: entry.avatar,
            avatarUrl: entry.avatarUrl
        });
        this.addBot(room);
        this.notifyMatchFound(room, [entry]);
        this.sendTo(entry.ws, { type: 'MATCH_BOT_FILLED', message: 'Belum ada pemain lain — kamu dilawankan dengan bot.' });
        this.startGame(room.code);
    }

    enqueueMatchmaking(ws, playerId, profile) {
        const entry = {
            ws,
            playerId,
            name: profile.name,
            avatar: profile.avatar,
            avatarUrl: profile.avatarUrl,
            timer: null
        };
        this.queue.push(entry);
        this.sendTo(ws, { type: 'MATCH_SEARCHING', message: 'Mencari pemain lain...' });

        entry.timer = setTimeout(() => {
            entry.timer = null;
            this.pairWithBot(entry);
        }, MATCH_BOT_FALLBACK_MS);

        this.tryMatch();
    }

    removeSocketFromRoom(server) {
        const meta = this.connections.get(server);
        if (!meta) return;

        this.connections.delete(server);

        // Kalau sedang antre matchmaking, cabut dari antrean
        const queued = this.queue.find((e) => e.ws === server);
        if (queued) this.dequeue(queued);

        const room = this.rooms.get(meta.roomCode);
        if (!room) return;
        if (room.members.get(meta.playerId)?.ws !== server) return;

        const orderIndex = room.order.indexOf(meta.playerId);
        room.members.delete(meta.playerId);
        if (orderIndex !== -1) room.order.splice(orderIndex, 1);

        if (room.game && orderIndex !== -1) {
            const game = room.game;
            if (orderIndex < game.players.length) game.players.splice(orderIndex, 1);

            if (game.players.length < MIN_PLAYERS) {
                this.stopBotTimer(room);
                room.game = null;
                this.broadcast(room.code, {
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

        this.promoteHostIfNeeded(room);

        this.broadcast(room.code, {
            type: 'PLAYER_LEFT',
            playerId: meta.playerId,
            playerList: this.publicPlayers(room)
        });

        const humansLeft = room.order.filter((id) => !room.members.get(id)?.isBot).length;
        if (humansLeft === 0) {
            this.stopBotTimer(room);
            this.rooms.delete(room.code);
            console.log(`Room ${room.code} dihapus (tidak ada pemain manusia).`);
            return;
        }

        if (room.game) {
            this.broadcastGameState(room.code);
            this.maybeRunBots(room.code);
        } else {
            this.broadcastLobby(room.code);
        }
    }

    getSession(server) {
        const meta = this.connections.get(server);
        if (!meta) return { meta: null, room: null, playerIndex: -1 };
        const room = this.rooms.get(meta.roomCode) || null;
        const playerIndex = room ? room.order.indexOf(meta.playerId) : -1;
        return { meta, room, playerIndex };
    }

    handleMessage(server, message) {
        const session = this.getSession(server);

        switch (message.type) {
            // ------------------------------------------------------------- LOBBY
            case 'CREATE_ROOM': {
                if (session.meta) {
                    this.sendError(server, 'Anda sudah berada di dalam room.');
                    return;
                }
                const playerId = this.sanitizePlayerId(message.playerId);
                if (!playerId) {
                    this.sendError(server, 'playerId tidak valid.');
                    return;
                }

                const profile = this.sanitizeProfile(message.profile);
                const room = this.createRoom('private', playerId);
                this.addHuman(room, playerId, server, profile);

                this.sendTo(server, {
                    type: 'ROOM_CREATED',
                    roomCode: room.code,
                    playerId,
                    hostId: room.hostId,
                    rules: room.rules,
                    playerList: this.publicPlayers(room)
                });
                console.log(`Room dibuat: ${room.code} oleh ${profile.name} (${playerId})`);
                return;
            }

            case 'JOIN_ROOM': {
                if (session.meta) {
                    this.sendError(server, 'Anda sudah berada di dalam room.');
                    return;
                }
                const playerId = this.sanitizePlayerId(message.playerId);
                if (!playerId) {
                    this.sendError(server, 'playerId tidak valid.');
                    return;
                }
                if (typeof message.roomCode !== 'string' || !message.roomCode.trim()) {
                    this.sendError(server, 'Kode room tidak boleh kosong.');
                    return;
                }

                const code = message.roomCode.trim().toUpperCase();
                const room = this.rooms.get(code);
                if (!room) {
                    this.sendError(server, 'Kode room tidak ditemukan.');
                    return;
                }
                if (room.game) {
                    this.sendError(server, 'Game di room ini sedang berjalan.');
                    return;
                }
                if (room.members.has(playerId)) {
                    this.sendError(server, 'Pemain dengan ID ini sudah ada di room.');
                    return;
                }
                if (room.order.length >= MAX_PLAYERS) {
                    this.sendError(server, `Room sudah penuh (maks ${MAX_PLAYERS} pemain).`);
                    return;
                }

                const profile = this.sanitizeProfile(message.profile);
                this.addHuman(room, playerId, server, profile);

                this.sendTo(server, {
                    type: 'ROOM_JOINED',
                    roomCode: room.code,
                    playerId,
                    hostId: room.hostId,
                    rules: room.rules,
                    playerList: this.publicPlayers(room)
                });
                this.broadcastLobby(room.code);
                console.log(`${profile.name} bergabung ke room ${room.code} (${room.order.length} pemain).`);
                return;
            }

            case 'FIND_MATCH': {
                if (session.meta) {
                    this.sendError(server, 'Anda sudah berada di dalam room.');
                    return;
                }
                const playerId = this.sanitizePlayerId(message.playerId);
                if (!playerId) {
                    this.sendError(server, 'playerId tidak valid.');
                    return;
                }
                if (this.queue.some((e) => e.playerId === playerId)) {
                    this.sendError(server, 'Anda sudah dalam antrean.');
                    return;
                }
                this.enqueueMatchmaking(server, playerId, this.sanitizeProfile(message.profile));
                return;
            }

            case 'CANCEL_MATCH': {
                const entry = this.queue.find((e) => e.ws === server);
                if (!entry) {
                    this.sendError(server, 'Anda tidak sedang dalam antrean.');
                    return;
                }
                this.dequeue(entry);
                this.sendTo(server, { type: 'MATCH_CANCELLED' });
                return;
            }

            case 'LEAVE_ROOM': {
                if (!session.meta) {
                    this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                    return;
                }
                this.removeSocketFromRoom(server);
                return;
            }

            case 'ADD_BOT': {
                const { meta, room } = session;
                if (!meta || !room) {
                    this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                    return;
                }
                if (!this.isHost(room, meta.playerId)) {
                    this.sendError(server, 'Hanya pembuat room yang bisa menambah bot.');
                    return;
                }
                if (room.game) {
                    this.sendError(server, 'Game sudah berjalan.');
                    return;
                }
                const botCount = room.order.filter((id) => room.members.get(id)?.isBot).length;
                if (botCount >= MAX_BOTS) {
                    this.sendError(server, `Maksimal ${MAX_BOTS} bot per room.`);
                    return;
                }
                if (room.order.length >= MAX_PLAYERS) {
                    this.sendError(server, `Room sudah penuh (maks ${MAX_PLAYERS} pemain).`);
                    return;
                }
                this.addBot(room);
                this.broadcastLobby(room.code);
                return;
            }

            case 'REMOVE_BOT': {
                const { meta, room } = session;
                if (!meta || !room) {
                    this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                    return;
                }
                if (!this.isHost(room, meta.playerId)) {
                    this.sendError(server, 'Hanya pembuat room yang bisa menghapus bot.');
                    return;
                }
                const botId = typeof message.botId === 'string' ? message.botId : '';
                const member = room.members.get(botId);
                if (!member || !member.isBot) {
                    this.sendError(server, 'Bot tidak ditemukan.');
                    return;
                }
                room.members.delete(botId);
                room.order = room.order.filter((id) => id !== botId);
                this.broadcastLobby(room.code);
                return;
            }

            case 'START_GAME': {
                const { meta, room } = session;
                if (!meta || !room) {
                    this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                    return;
                }
                if (!this.isHost(room, meta.playerId)) {
                    this.sendError(server, 'Hanya pembuat room yang bisa memulai game.');
                    return;
                }
                if (room.game) {
                    this.sendError(server, 'Game sudah berjalan.');
                    return;
                }
                if (room.order.length < MIN_PLAYERS) {
                    this.sendError(server, `Butuh minimal ${MIN_PLAYERS} pemain. Tambah bot kalau belum ada lawan.`);
                    return;
                }
                this.startGame(meta.roomCode);
                return;
            }

        // ------------------------------------------------------- ATURAN RUMAHAN
        case 'SET_RULES': {
            const { meta, room } = session;
            if (!meta || !room) {
                this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                return;
            }
            if (!this.isHost(room, meta.playerId)) {
                this.sendError(server, 'Hanya pembuat room yang bisa mengubah aturan.');
                return;
            }
            if (room.game) {
                this.sendError(server, 'Aturan tidak bisa diubah saat game berjalan.');
                return;
            }

            room.rules = {
                multiPlay: Boolean(message.multiPlay),
                stacking: Boolean(message.stacking)
            };
            this.broadcastLobby(meta.roomCode);
            return;
        }

            // -------------------------------------------------------------- CHAT
            case 'CHAT_SEND': {
                const { meta, room } = session;
                if (!meta || !room) {
                    this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                    return;
                }

                const text = sanitizeChat(message.text);
                if (!text) {
                    this.sendError(server, 'Pesan kosong atau terlalu panjang.');
                    return;
                }

                const me = room.members.get(meta.playerId);
                this.broadcast(meta.roomCode, {
                    type: 'CHAT_MESSAGE',
                    playerId: meta.playerId,
                    name: me ? me.name : '?',
                    avatar: me ? me.avatar : 'fallback',
                    avatarUrl: me ? me.avatarUrl : null,
                    isBot: Boolean(me && me.isBot),
                    text,
                    at: Date.now()
                });
                return;
            }

            // -------------------------------------------------------------- GAME
            case 'DRAW_CARD': {
                const { meta, room, playerIndex } = session;
                if (!meta || !room) {
                    this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                    return;
                }
                if (!room.game) {
                    this.sendError(server, 'Game belum dimulai.');
                    return;
                }
                if (playerIndex === -1 || room.game.currentPlayerIndex !== playerIndex) {
                    this.sendError(server, 'Bukan giliran Anda.');
                    return;
                }

                // Ada hukuman menggantung (aturan menumpuk): ambil semuanya.
                if (room.game.pendingDraw > 0) {
                    resolvePendingDraw(room.game, playerIndex);
                    this.broadcastGameState(meta.roomCode);
                    this.maybeRunBots(meta.roomCode);
                    return;
                }

                const updated = playerDrawsCard(room.game, playerIndex, true);
                if (!updated) {
                    this.sendError(server, 'Tidak dapat mengambil kartu (dek habis).');
                    return;
                }
                this.broadcastGameState(meta.roomCode);
                this.maybeRunBots(meta.roomCode);
                return;
            }

            case 'PLAY_CARD': {
                const { meta, room, playerIndex } = session;
                if (!meta || !room) {
                    this.sendError(server, 'Anda tidak sedang berada di room mana pun.');
                    return;
                }
                if (!room.game) {
                    this.sendError(server, 'Game belum dimulai.');
                    return;
                }
                if (playerIndex === -1 || room.game.currentPlayerIndex !== playerIndex) {
                    this.sendError(server, 'Bukan giliran Anda.');
                    return;
                }

                // Klien boleh kirim satu kartu (card) atau beberapa (cards).
                const raw = Array.isArray(message.cards) ? message.cards : [message.card];
                if (raw.length === 0 || raw.length > 8) {
                    this.sendError(server, 'Jumlah kartu tidak masuk akal.');
                    return;
                }
                const cards = [];
                for (const c of raw) {
                    const clean = this.sanitizeCard(c);
                    if (!clean) {
                        this.sendError(server, 'Data kartu tidak valid.');
                        return;
                    }
                    cards.push(clean);
                }

                let chosenColor = null;
                if (cards.some((c) => c.color === 'WILD')) {
                    chosenColor = typeof message.chosenColor === 'string' ? message.chosenColor.toUpperCase() : null;
                    if (!UNO_COLORS.includes(chosenColor)) {
                        this.sendError(server, 'Warna pilihan tidak valid untuk kartu Wild.');
                        return;
                    }
                }

                const reason = validatePlaySet(room.game, playerIndex, cards, chosenColor);
                if (reason) {
                    this.sendError(server, reason);
                    return;
                }

                const updated = playCards(room.game, playerIndex, cards, chosenColor);
                if (!updated) {
                    this.sendError(server, 'Kartu tidak valid untuk dimainkan.');
                    return;
                }

                const me = room.members.get(meta.playerId);
                if (updated.players[playerIndex].length === 1) {
                    updated.messages.push({
                        type: 'warning',
                        text: `${me ? me.name : 'Pemain'} tinggal 1 kartu — UNO!`
                    });
                }

                this.broadcastGameState(meta.roomCode);

                if (updated.players[playerIndex].length === 0) {
                    this.endGame(meta.roomCode, playerIndex);
                    return;
                }
                this.maybeRunBots(meta.roomCode);
                return;
            }

            default:
                console.warn('Tipe pesan tidak dikenal:', message?.type);
                this.sendError(server, 'Tipe pesan tidak dikenal.');
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point Worker: teruskan setiap WebSocket ke SATU Durable Object.
// ---------------------------------------------------------------------------

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/websocket') {
            // 'uno-global' => selalu instance yang sama untuk semua pemain.
            const id = env.UNO.idFromName('uno-global');
            return env.UNO.get(id).fetch(request);
        }

        return new Response('Endpoint tidak ditemukan. Gunakan /websocket untuk koneksi game Uno.', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
};
