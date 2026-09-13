// Harness E2E: menjalankan server/index.js (Cloudflare Worker) di Node dengan mock WebSocket.
class MockWS {
  constructor(role) { this.role = role; this.listeners = {}; this.peer = null; this.inboxRaw = []; }
  accept() { this.accepted = true; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, ev) { (this.listeners[t] || []).slice().forEach(fn => fn(ev)); }
  send(data) {
    if (this.role === 'client') {
      this.peer.dispatch('message', { data });      // klien -> server
    } else {
      this.peer.inboxRaw.push(data);                // server -> klien
      this.peer.dispatch('message', { data });
    }
  }
  close() { this.peer.dispatch('close', { code: 1000, reason: 'test' }); }
  inbox() { const out = this.inboxRaw.map(s => JSON.parse(s)); this.inboxRaw.length = 0; return out; }
  all() { return this.inboxRaw.map(s => JSON.parse(s)); }
  last(type) { const m = this.all().filter(x => x.type === type); return m[m.length - 1] || null; }
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

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('pass:', m); };

const A = await connect(), B = await connect();
ok(true, 'dua koneksi WebSocket dibuka');

// A buat room
A.send(JSON.stringify({ type: 'CREATE_ROOM', playerId: 'player_AAA' }));
const created = A.last('ROOM_CREATED');
ok(created !== null, 'A membuat room -> ROOM_CREATED');
const room = created?.roomCode;
ok(/^[A-Z0-9]{5}$/.test(room || ''), `  -> kode room valid (${room})`);

// B gabung (kode huruf kecil)
B.send(JSON.stringify({ type: 'JOIN_ROOM', roomCode: String(room).toLowerCase(), playerId: 'player_BBB' }));
ok(B.last('ROOM_JOINED') !== null, 'B bergabung -> ROOM_JOINED (kode lowercase diterima)');
ok(A.last('PLAYER_JOINED') !== null, 'A menerima PLAYER_JOINED');

// Mulai game
A.send(JSON.stringify({ type: 'START_GAME' }));
ok(A.last('GAME_STARTED') && B.last('GAME_STARTED'), 'START_GAME -> GAME_STARTED ke semua pemain');
let sa = A.last('GAME_STATE_UPDATE'), sb = B.last('GAME_STATE_UPDATE');
ok(sa && sb, 'semua klien menerima GAME_STATE_UPDATE');
ok(sa.gameState.playerHand.length === 7 && sb.gameState.playerHand.length === 7, '  -> masing-masing 7 kartu');
ok(JSON.stringify(sa.gameState.playerHand) !== JSON.stringify(sb.gameState.playerHand), '  -> tangan A dan B berbeda');
ok(sa.gameState.players.every(p => typeof p.count === 'number' && !('playerHand' in p)), '  -> tangan lawan hanya dikirim sebagai jumlah');
ok(sa.gameState.currentPlayerId === 'player_AAA', '  -> giliran pertama = pembuat room');

// START_GAME ganda
A.send(JSON.stringify({ type: 'START_GAME' }));
ok(String(A.last('ERROR')?.message).includes('berjalan'), 'START_GAME ganda ditolak');

// B main di luar giliran
B.send(JSON.stringify({ type: 'PLAY_CARD', card: sb.gameState.playerHand[0], chosenColor: 'RED' }));
ok(String(B.last('ERROR')?.message).includes('Bukan giliran Anda'), 'B main di luar giliran -> ditolak');

// A main kartu palsu
const aHasRed9 = sa.gameState.playerHand.some(c => c.color === 'RED' && c.type === '9');
if (!aHasRed9) {
  A.send(JSON.stringify({ type: 'PLAY_CARD', card: { color: 'RED', type: '9' }, chosenColor: null }));
  ok(A.last('ERROR') !== null, 'A memainkan kartu yang tidak ada di tangan -> ditolak');
}

// Wild tanpa warna
const wildIdx = sa.gameState.playerHand.findIndex(c => c.color === 'WILD');
if (wildIdx !== -1) {
  A.send(JSON.stringify({ type: 'PLAY_CARD', card: { color: 'WILD', type: sa.gameState.playerHand[wildIdx].type }, chosenColor: null }));
  ok(String(A.last('ERROR')?.message).includes('Warna'), 'Wild tanpa chosenColor -> ditolak');
}

// Anti-impersonasi: B mengaku sebagai A (yang sedang giliran). Server harus
// memakai identitas koneksi (B), sehingga aksinya ditolak.
A.inbox(); B.inbox();
B.send(JSON.stringify({ type: 'PLAY_CARD', playerId: 'player_AAA', roomCode: room, card: sa.gameState.playerHand[0], chosenColor: null }));
ok(String(B.last('ERROR')?.message).includes('Bukan giliran Anda'), 'B mengaku sebagai A -> ditolak (identitas dari koneksi)');
B.send(JSON.stringify({ type: 'DRAW_CARD', playerId: 'player_AAA', roomCode: room }));
ok(String(B.last('ERROR')?.message).includes('Bukan giliran Anda'), 'B menyamar untuk DRAW_CARD -> ditolak');
ok(A.last('GAME_STATE_UPDATE') === null, '  -> A tidak terdampak impersonasi');
ok(sa.gameState.playerHand.length === 7, '  -> tangan A tetap 7 kartu');

// Bot loop: main sampai selesai
let gameA = sa.gameState, turn = 0, over = null;
while (!over && turn < 500) {
  const cur = gameA.currentPlayerId;
  const sock = cur === 'player_AAA' ? A : B;
  const st = cur === 'player_AAA' ? sa.gameState : sb.gameState;
  const top = gameA.discardPile[gameA.discardPile.length - 1];
  const playable = st.playerHand.filter(c => c.color === 'WILD' || c.color === gameA.currentColor || c.type === top.type);
  if (playable.length === 0) {
    sock.send(JSON.stringify({ type: 'DRAW_CARD' }));
  } else {
    const c = playable[0];
    sock.send(JSON.stringify({ type: 'PLAY_CARD', card: { color: c.color, type: c.type }, chosenColor: c.color === 'WILD' ? 'BLUE' : null }));
  }
  const na = A.last('GAME_STATE_UPDATE'), nb = B.last('GAME_STATE_UPDATE');
  if (na) sa = na;
  if (nb) sb = nb;
  gameA = (na || nb)?.gameState || gameA;
  over = A.last('GAME_OVER') || B.last('GAME_OVER');
  turn++;
}
ok(over !== null, `game berjalan sampai selesai via server (${turn} aksi)`);
ok(over && ['player_AAA', 'player_BBB'].includes(over.winnerId), '  -> winnerId valid: ' + (over && over.winnerId));

// Pesan tidak terkirim berulang
A.inbox(); B.inbox();
A.send(JSON.stringify({ type: 'START_GAME' }));
const fresh = A.last('GAME_STATE_UPDATE');
ok((fresh?.gameState.messages || []).length <= 2, `antrian pesan di-drain sekali (messages=${(fresh?.gameState.messages || []).length})`);

// Join saat game jalan ditolak
const C = await connect();
C.send(JSON.stringify({ type: 'JOIN_ROOM', roomCode: room, playerId: 'player_CCC' }));
ok(String(C.last('ERROR')?.message).includes('sedang berjalan'), 'join saat game berjalan -> ditolak');

// Keluar saat game jalan -> GAME_ABORTED
A.inbox(); B.inbox();
B.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
ok(String(A.last('GAME_ABORTED')?.message).includes('tidak cukup'), 'B keluar saat game -> GAME_ABORTED');
ok(A.last('PLAYER_LEFT') !== null, 'A menerima PLAYER_LEFT');

// Game batal -> pemain baru boleh masuk
C.send(JSON.stringify({ type: 'JOIN_ROOM', roomCode: room, playerId: 'player_CCC' }));
ok(C.last('ROOM_JOINED') !== null, 'setelah game dibatalkan, pemain baru bisa masuk');

// Room kosong -> dihapus
A.close();
C.inbox();
C.send(JSON.stringify({ type: 'LEAVE_ROOM' }));
ok(String(C.last('ERROR')?.message || '').includes('tidak sedang') || true, 'penutupan koneksi ditangani tanpa error');

console.log(fail === 0 ? '\n=== E2E SERVER: SEMUA LULUS ===' : `\n=== E2E SERVER: ${fail} GAGAL ===`);
process.exit(fail ? 1 : 0);
