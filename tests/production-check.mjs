// tests/production-check.mjs — uji regresi terhadap Worker yang SUDAH ter-deploy.
//
// Ini yang menangkap bug "Kode room tidak ditemukan". Penyebabnya: state room
// disimpan di Map tingkat modul, sedangkan Cloudflare menjalankan Worker di
// banyak isolate, sehingga room yang dibuat di satu isolate tidak terlihat oleh
// pemain yang mendarat di isolate lain. Gejalanya acak: kadang berhasil.
//
// Karena itu tes ini mengulang berkali-kali. Kalau satu saja gagal, berarti
// routing ke Durable Object bermasalah.
//
//   node tests/production-check.mjs
//   UNO_URL=https://xxx.workers.dev node tests/production-check.mjs

const BASE = (process.env.UNO_URL || 'https://uno-game-server-ins.officialrealmuoriginal.workers.dev').replace(/\/$/, '');
const URL_WS = BASE.replace(/^http/, 'ws') + '/websocket';
const ROUNDS = Number(process.env.ROUNDS || 8);

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('pass:', m); };

function open() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(URL_WS);
        const t = setTimeout(() => reject(new Error('timeout saat membuka koneksi')), 15000);
        ws.addEventListener('open', () => { clearTimeout(t); resolve(ws); });
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('koneksi gagal')); });
    });
}

function inbox(ws) {
    const q = [];
    const waiters = [];
    ws.addEventListener('message', (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        const i = waiters.findIndex((w) => w.type === m.type);
        if (i !== -1) {
            const w = waiters.splice(i, 1)[0];
            clearTimeout(w.t);
            w.resolve(m);
        } else {
            q.push(m);
        }
    });
    return {
        waitFor(type, ms = 9000) {
            const hit = q.findIndex((m) => m.type === type);
            if (hit !== -1) return Promise.resolve(q.splice(hit, 1)[0]);
            return new Promise((resolve) => {
                const w = { type, resolve };
                w.t = setTimeout(() => resolve(null), ms);
                waiters.push(w);
            });
        },
        error(ms = 1500) { return this.waitFor('ERROR', ms); }
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (ws, obj) => ws.send(JSON.stringify(obj));

console.log(`target: ${URL_WS}`);
console.log(`putaran: ${ROUNDS}\n`);

// --- 1. Halaman & aset -------------------------------------------------------
console.log('--- 1. Halaman & aset statis ---');
const page = await fetch(BASE + '/', { signal: AbortSignal.timeout(20000) });
ok(page.status === 200, `halaman utama HTTP ${page.status}`);
const html = await page.text();
ok(html.includes('<title>Uno Online</title>'), 'HTML yang dilayani benar');
const appJs = await fetch(BASE + '/app.js', { signal: AbortSignal.timeout(20000) });
ok(appJs.status === 200, `app.js HTTP ${appJs.status}`);
const card = await fetch(BASE + '/assets/cards/RED_5.png', { signal: AbortSignal.timeout(20000) });
ok(card.status === 200, `kartu HTTP ${card.status}`);
const avatar = await fetch(BASE + '/assets/avatars/a01.png', { signal: AbortSignal.timeout(20000) });
ok(avatar.status === 200, `avatar HTTP ${avatar.status}`);

// Aset UI: font game harus ikut ter-deploy, kalau tidak tampilannya jatuh ke font sistem
const cssRes = await fetch(BASE + '/style.css', { signal: AbortSignal.timeout(20000) });
const css = await cssRes.text();
ok(css.includes('Fredoka'), 'CSS memakai font game (Fredoka)');
for (const f of ['Fredoka', 'Nunito']) {
    const r = await fetch(`${BASE}/assets/fonts/${f}.woff2`, { signal: AbortSignal.timeout(20000) });
    ok(r.status === 200, `font ${f}.woff2 HTTP ${r.status} (${r.headers.get('content-type')})`);
}
ok(html.includes('table-felt') && html.includes('logo-uno'), 'struktur UI game terkirim di HTML');

// --- 2. Kode room harus selalu bisa dipakai ---------------------------------
console.log('\n--- 2. Buat room lalu gabung dari koneksi lain ---');
let joinOk = 0;
for (let i = 1; i <= ROUNDS; i++) {
    const wsA = await open();
    const A = inbox(wsA);
    send(wsA, { type: 'CREATE_ROOM', playerId: 'host' + i, profile: { name: 'Host' + i, avatar: 'a01' } });
    const created = await A.waitFor('ROOM_CREATED');
    if (!created) { console.log(`  putaran ${i}: CREATE_ROOM gagal`); wsA.close(); continue; }

    const wsB = await open();
    const B = inbox(wsB);
    send(wsB, { type: 'JOIN_ROOM', roomCode: created.roomCode, playerId: 'guest' + i, profile: { name: 'Tamu' + i, avatar: 'a02' } });
    const joined = await B.waitFor('ROOM_JOINED');
    const err = joined ? null : await B.error(1500);

    if (joined) { joinOk++; console.log(`  putaran ${i}: ${created.roomCode} -> BERHASIL`); }
    else { console.log(`  putaran ${i}: ${created.roomCode} -> GAGAL (${err ? err.message : 'tanpa balasan'})`); }

    wsA.close(); wsB.close();
    await sleep(300);
}
ok(joinOk === ROUNDS, `gabung room berhasil ${joinOk}/${ROUNDS}`);
ok(joinOk > 0, 'setidaknya ada satu yang berhasil (server hidup)');

// --- 3. Matchmaking ----------------------------------------------------------
console.log('\n--- 3. Cari lawan (matchmaking) ---');
const wsC = await open(), wsD = await open();
const C = inbox(wsC), D = inbox(wsD);
send(wsC, { type: 'FIND_MATCH', playerId: 'mm1', profile: { name: 'Cari1', avatar: 'a05' } });
send(wsD, { type: 'FIND_MATCH', playerId: 'mm2', profile: { name: 'Cari2', avatar: 'a06' } });
const mC = await C.waitFor('MATCH_FOUND', 12000);
const mD = await D.waitFor('MATCH_FOUND', 12000);
ok(mC && mD, 'dua pemain di antrean dipasangkan');
ok(mC && mD && mC.roomCode === mD.roomCode, `keduanya dapat room yang sama (${mC && mC.roomCode})`);
ok(!(mC && mC.playerList.some((p) => p.isBot)), 'tanpa bot karena ada lawan manusia');
const startC = await C.waitFor('GAME_STARTED', 5000);
ok(startC !== null, 'game matchmaking otomatis dimulai');

// --- 4. Obrolan --------------------------------------------------------------
console.log('\n--- 4. Obrolan ---');
send(wsC, { type: 'CHAT_SEND', text: 'halo dari produksi' });
const chC = await C.waitFor('CHAT_MESSAGE', 5000);
const chD = await D.waitFor('CHAT_MESSAGE', 5000);
ok(chC && chD, 'chat terkirim ke kedua pemain');
ok(chC?.text === 'halo dari produksi', 'isi pesan utuh');

wsC.close(); wsD.close();

console.log(fail === 0 ? '\n=== PRODUKSI: SEMUA LULUS ===' : `\n=== PRODUKSI: ${fail} GAGAL ===`);
process.exit(fail ? 1 : 0);
