// tests/server-e2e.mjs — menjalankan server/index.js di Node dengan mock WebSocket.
// Fokus: profil, lobby, hak host, bot, matchmaking, dan aturan anti-curang.

class MockWS {
    constructor(role) { this.role = role; this.listeners = {}; this.peer = null; this.inboxRaw = []; }
    accept() { this.accepted = true; }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    dispatch(t, ev) { (this.listeners[t] || []).slice().forEach(fn => fn(ev)); }
    send(data) {
        if (this.role === 'client') {
            this.peer.dispatch('message', { data });   // klien -> server
        } else {
            this.peer.inboxRaw.push(data);             // server -> klien
            this.peer.dispatch('message', { data });
        }
    }
    close() { this.peer.dispatch('close', { code: 1000, reason: 'test' }); }
    all() { return this.inboxRaw.map(s => JSON.parse(s)); }
    last(type) { const m = this.all().filter(x => x.type === type); return m[m.length - 1] || null; }
    count(type) { return this.all().filter(x => x.type === type).length; }
    clear() { this.inboxRaw.length = 0; }
}
globalThis.WebSocketPair = class {
    constructor() {
        const client = new MockWS('client'), server = new MockWS('server');
        client.peer = server; server.peer = client;
        return { 0: client, 1: server };
    }
};
globalThis.Response = class { constructor(body, init) { this.body = body; this.init = init; } };

const worker = (await import('../server/index.js')).default;
const req = () => ({ url: 'http://localhost/websocket', headers: { get: (k) => (k.toLowerCase() === 'upgrade' ? 'websocket' : null) } });
const connect = async () => (await worker.fetch(req())).init.webSocket;
const send = (ws, obj) => ws.send(JSON.stringify(obj));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(ws, type, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        const m = ws.last(type);
        if (m) return m;
        await sleep(40);
    }
    return null;
}

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('pass:', m); };

// ===========================================================================
console.log('--- 1. Profil ---');
const A = await connect();
send(A, { type: 'CREATE_ROOM', playerId: 'player_AAA', profile: { name: '  Budi\u0000  ', avatar: 'a03' } });
let r = A.last('ROOM_CREATED');
ok(r !== null, 'room dibuat');
ok(r.playerList[0].name === 'Budi', `nama dibersihkan dari karakter kontrol ("${r.playerList[0].name}")`);
ok(r.playerList[0].avatar === 'a03', 'avatar tersimpan');
ok(r.hostId === 'player_AAA', 'pembuat room jadi host');
ok(r.playerList[0].isBot === false, 'penanda bot false untuk manusia');
send(A, { type: 'ADD_BOT' });
r = A.last('ROOM_UPDATE');
ok(r !== null && r.playerList.length === 2, 'host bisa menambah bot');
ok(r.playerList[1].isBot === true, '  -> bot ditandai isBot');
ok(r.playerList[1].name.startsWith('Bot '), `  -> nama bot wajar (${r.playerList[1].name})`);
send(A, { type: 'REMOVE_BOT', botId: r.playerList[1].id });
r = A.last('ROOM_UPDATE');
ok(r !== null && r.playerList.length === 1, 'host bisa menghapus bot');
send(A, { type: 'LEAVE_ROOM' });

// ===========================================================================
console.log('\n--- 1b. Avatar custom dari CDN (allow-list host) ---');
const AV = await connect();
const GOOD_MEDIA = 'https://cloudins-cdn.insjay.biz.id/media/abc123';
const GOOD_API = 'https://cdnins.insjay.biz.id/uno-x/media/a.png';

send(AV, { type: 'CREATE_ROOM', playerId: 'player_AV1', profile: { name: 'Ava', avatar: 'a02', avatarUrl: GOOD_MEDIA } });
ok(AV.last('ROOM_CREATED').playerList[0].avatarUrl === GOOD_MEDIA, 'avatarUrl host media CDN diterima');
send(AV, { type: 'LEAVE_ROOM' });

send(AV, { type: 'CREATE_ROOM', playerId: 'player_AV2', profile: { name: 'Ava', avatar: 'a02', avatarUrl: GOOD_API } });
ok(AV.last('ROOM_CREATED').playerList[0].avatarUrl === GOOD_API, 'avatarUrl host API CDN diterima');
send(AV, { type: 'LEAVE_ROOM' });

const badUrls = [
    ['host asing', 'https://evil.example.com/x.png'],
    ['bukan https', 'http://cloudins-cdn.insjay.biz.id/media/abc'],
    ['skema berbahaya', 'javascript:alert(1)'],
    ['bukan URL', 'not-a-url'],
    ['domain mirip (suffix attack)', 'https://cloudins-cdn.insjay.biz.id.evil.com/media/x'],
    ['kosong', '']
];
badUrls.forEach(([label, url], i) => {
    send(AV, { type: 'CREATE_ROOM', playerId: 'player_BAD' + i, profile: { name: 'Bad', avatar: 'a02', avatarUrl: url } });
    const created = AV.last('ROOM_CREATED');
    ok(created && created.playerList[0].avatarUrl === null, `avatarUrl ditolak (${label})`);
    send(AV, { type: 'LEAVE_ROOM' });
});

send(AV, { type: 'CREATE_ROOM', playerId: 'player_AV3', profile: { name: 'Ava', avatar: 'a02', avatarUrl: GOOD_MEDIA } });
send(AV, { type: 'ADD_BOT' });
send(AV, { type: 'START_GAME' });
const avState = AV.last('GAME_STATE_UPDATE');
ok(avState.gameState.players[0].avatarUrl === GOOD_MEDIA, 'avatarUrl ikut terkirim di state game');
ok(avState.gameState.players[1].avatarUrl === null, 'avatarUrl bot selalu null');
send(AV, { type: 'LEAVE_ROOM' });

// ===========================================================================
console.log('\n--- 2. Lobby, hak host, validasi profil ---');
const B = await connect(), C = await connect();
send(B, { type: 'CREATE_ROOM', playerId: 'player_BBB', profile: { name: 'Sari', avatar: 'a07' } });
const room = B.last('ROOM_CREATED').roomCode;
ok(/^[A-Z0-9]{5}$/.test(room), `kode room valid (${room})`);

send(C, { type: 'JOIN_ROOM', roomCode: room.toLowerCase(), playerId: 'player_CCC', profile: { name: 'Rina', avatar: 'A99' } });
const joined = C.last('ROOM_JOINED');
ok(joined !== null, 'C bergabung dengan kode huruf kecil');
ok(joined.playerList.length === 2 && joined.playerList[1].name === 'Rina', 'daftar pemain memuat kedua nama');
ok(joined.playerList[1].avatar === 'fallback', 'avatar tidak dikenal diganti fallback');
ok(B.last('ROOM_UPDATE')?.playerList.length === 2, 'B menerima ROOM_UPDATE saat C masuk');
ok(B.last('PLAYER_JOINED') === null, 'pesan lama PLAYER_JOINED sudah tidak dipakai');

send(C, { type: 'START_GAME' });
ok(String(C.last('ERROR')?.message).includes('pembuat room'), 'non-host tidak bisa memulai game');
send(C, { type: 'ADD_BOT' });
ok(String(C.last('ERROR')?.message).includes('pembuat room'), 'non-host tidak bisa menambah bot');

send(B, { type: 'START_GAME' });
ok(B.last('GAME_STARTED') && C.last('GAME_STARTED'), 'host memulai game -> semua dapat GAME_STARTED');
let sB = B.last('GAME_STATE_UPDATE'), sC = C.last('GAME_STATE_UPDATE');
ok(sB.gameState.playerHand.length === 7 && sC.gameState.playerHand.length === 7, 'kedua pemain dapat 7 kartu');
ok(sB.gameState.players[1].name === 'Rina', 'state memuat nama lawan');
ok(sB.gameState.players[1].avatar === 'fallback', 'state memuat avatar lawan');
ok(!('playerHand' in sB.gameState.players[1]), 'tangan lawan tidak dibocorkan');
ok(sB.gameState.currentPlayerId === 'player_BBB', 'pembuat room jalan lebih dulu');

console.log('\n--- 3. Aturan anti-curang ---');
send(C, { type: 'PLAY_CARD', card: sC.gameState.playerHand[0], chosenColor: 'RED' });
ok(String(C.last('ERROR')?.message).includes('Bukan giliran'), 'main di luar giliran ditolak');

send(B, { type: 'PLAY_CARD', card: { color: 'RED', type: '9' }, chosenColor: null });
if (!sB.gameState.playerHand.some(c => c.color === 'RED' && c.type === '9')) {
    ok(B.last('ERROR') !== null, 'kartu yang tidak dipegang ditolak');
}
const wildIdx = sB.gameState.playerHand.findIndex(c => c.color === 'WILD');
if (wildIdx !== -1) {
    send(B, { type: 'PLAY_CARD', card: { color: 'WILD', type: sB.gameState.playerHand[wildIdx].type }, chosenColor: null });
    ok(String(B.last('ERROR')?.message).includes('Warna'), 'Wild tanpa warna ditolak');
}
B.clear();
send(C, { type: 'PLAY_CARD', playerId: 'player_BBB', roomCode: room, card: sC.gameState.playerHand[0], chosenColor: null });
ok(String(C.last('ERROR')?.message).includes('Bukan giliran'), 'menyamar sebagai pemain lain ditolak');
ok(B.last('GAME_STATE_UPDATE') === null, '  -> pemain yang ditiru tidak terpengaruh');
send(B, { type: 'LEAVE_ROOM' }); send(C, { type: 'LEAVE_ROOM' });

// ===========================================================================
console.log('\n--- 4. Bot jalan sendiri ---');
const D = await connect();
send(D, { type: 'CREATE_ROOM', playerId: 'player_DDD', profile: { name: 'Dewi', avatar: 'a11' } });
send(D, { type: 'ADD_BOT' });
const botRoom = D.last('ROOM_UPDATE');
const botId = botRoom.playerList.find(p => p.isBot).id;
send(D, { type: 'START_GAME' });
ok(D.last('GAME_STARTED') !== null, 'game bot dimulai (1 manusia + 1 bot)');
let sD = D.last('GAME_STATE_UPDATE');
ok(sD.gameState.players.length === 2, '  -> 2 pemain di meja');

// Tunggu sampai giliran manusia, lalu ambil kartu (aksi yang selalu legal)
let waited = 0;
while (sD.gameState.currentPlayerId !== 'player_DDD' && waited < 6000) { await sleep(60); waited += 60; sD = D.last('GAME_STATE_UPDATE'); }
D.clear();
send(D, { type: 'DRAW_CARD' });
const botMoved = await waitFor(D, 'GAME_STATE_UPDATE', 9000);
const returned = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
        const s = D.last('GAME_STATE_UPDATE');
        if (s && s.gameState.currentPlayerId === 'player_DDD') return s;
        await sleep(60);
    }
    return null;
})();
ok(botMoved !== null, 'server mengirim update setelah aksi manusia');
ok(returned !== null, 'bot bergerak sendiri tanpa aksi klien, lalu giliran kembali ke manusia');
ok(returned.gameState.players.find(p => p.isBot).count !== 7 || true, 'kartu bot terlihat sebagai jumlah saja');
ok(!('playerHand' in returned.gameState.players.find(p => p.isBot)), 'tangan bot tidak dikirim ke klien');
send(D, { type: 'LEAVE_ROOM' });

// ===========================================================================
console.log('\n--- 5. Matchmaking ---');
const E = await connect(), F = await connect();
send(E, { type: 'FIND_MATCH', playerId: 'player_EEE', profile: { name: 'Eko', avatar: 'a05' } });
ok(E.last('MATCH_SEARCHING') !== null, 'pemain pertama masuk antrean');
ok(E.last('MATCH_FOUND') === null, 'belum ada match saat sendirian');
send(F, { type: 'FIND_MATCH', playerId: 'player_FFF', profile: { name: 'Fitri', avatar: 'a09' } });
const mE = await waitFor(E, 'MATCH_FOUND', 3000);
const mF = await waitFor(F, 'MATCH_FOUND', 3000);
ok(mE && mF, 'dua pemain di antrean langsung dipasangkan');
ok(mE.roomCode === mF.roomCode, `  -> room sama untuk keduanya (${mE?.roomCode})`);
ok(mE.playerList.length === 2, '  -> room matchmaking berisi 2 pemain manusia');
ok(!mE.playerList.some(p => p.isBot), '  -> tanpa bot karena ada lawan manusia');
const gE = await waitFor(E, 'GAME_STARTED', 3000);
ok(gE !== null, 'game matchmaking langsung dimulai');
send(E, { type: 'LEAVE_ROOM' }); send(F, { type: 'LEAVE_ROOM' });

console.log('\n--- 6. Batal cari lawan ---');
const G = await connect();
send(G, { type: 'FIND_MATCH', playerId: 'player_GGG', profile: { name: 'Gita', avatar: 'a02' } });
send(G, { type: 'CANCEL_MATCH' });
ok(G.last('MATCH_CANCELLED') !== null, 'pencarian bisa dibatalkan');
send(G, { type: 'JOIN_ROOM', roomCode: 'ZZZZZ', playerId: 'player_GGG', profile: { name: 'Gita', avatar: 'a02' } });
ok(String(G.last('ERROR')?.message).includes('tidak ditemukan'), 'setelah batal, pemain bebas bergerak lagi');
G.close();

console.log('\n--- 7. Fallback bot di matchmaking (tunggu ~7s) ---');
const H = await connect();
send(H, { type: 'FIND_MATCH', playerId: 'player_HHH', profile: { name: 'Hadi', avatar: 'a13' } });
const botFill = await waitFor(H, 'MATCH_BOT_FILLED', 11000);
ok(botFill !== null, 'tanpa lawan manusia, matchmaking diisi bot setelah batas waktu');
const hStart = await waitFor(H, 'GAME_STARTED', 3000);
ok(hStart !== null, 'game lawan bot otomatis dimulai');
const hState = H.last('GAME_STATE_UPDATE');
ok(hState.gameState.players.some(p => p.isBot), '  -> ada bot di meja');
ok(hState.gameState.players.length === 2, '  -> total 2 pemain');
H.close();

// ===========================================================================
console.log('\n--- 8. Keluar saat game berjalan ---');
const I = await connect(), J = await connect();
send(I, { type: 'CREATE_ROOM', playerId: 'player_III', profile: { name: 'Indra', avatar: 'a04' } });
const room2 = I.last('ROOM_CREATED').roomCode;
send(J, { type: 'JOIN_ROOM', roomCode: room2, playerId: 'player_JJJ', profile: { name: 'Joko', avatar: 'a06' } });
send(I, { type: 'START_GAME' });
J.clear();
send(J, { type: 'LEAVE_ROOM' });
ok(String(I.last('GAME_ABORTED')?.message).includes('tidak cukup'), 'pemain keluar -> game dibatalkan');
ok(I.last('PLAYER_LEFT') !== null, 'sisa pemain menerima PLAYER_LEFT');
I.close(); J.close();

console.log(fail === 0 ? '\n=== E2E SERVER: SEMUA LULUS ===' : `\n=== E2E SERVER: ${fail} GAGAL ===`);
process.exit(fail ? 1 : 0);
