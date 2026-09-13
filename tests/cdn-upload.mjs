// tests/cdn-upload.mjs — integrasi nyata ke CDN INS (cdnins.insjay.biz.id).
//
// Tes ini MENULIS file sungguhan ke CDN, jadi tidak ikut `npm test`.
// Jalankan manual kalau endpoint CDN-nya berubah:
//
//     RUN_CDN_TEST=1 node tests/cdn-upload.mjs
//
// Kontrak yang diuji:
//   POST {CDN}/upload-send
//     header: x-user-id, x-filename
//     body  : multipart/form-data, field "file"
//   respons: { success, url|public_url, fix_url|user_media_url, filename }

const CDN = {
    uploadUrl: 'https://cdnins.insjay.biz.id/upload-send',
    allowedHosts: ['cloudins-cdn.insjay.biz.id', 'cdnins.insjay.biz.id']
};

if (process.env.RUN_CDN_TEST !== '1') {
    console.log('Dilewati (butuh jaringan + menulis file ke CDN).');
    console.log('Jalankan: RUN_CDN_TEST=1 node tests/cdn-upload.mjs');
    process.exit(0);
}

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('pass:', m); };

function isAllowed(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && CDN.allowedHosts.includes(u.hostname);
    } catch {
        return false;
    }
}

// PNG 1x1 transparan
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

const userId = 'uno-selftest-' + Math.random().toString(36).slice(2, 8);
const filename = `uno-selftest-${Date.now()}.png`;

const form = new FormData();
form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), filename);

console.log(`POST ${CDN.uploadUrl}  (x-user-id: ${userId})`);

let res;
try {
    res = await fetch(CDN.uploadUrl, {
        method: 'POST',
        headers: { 'x-user-id': userId, 'x-filename': filename },
        body: form,
        signal: AbortSignal.timeout(45000)
    });
} catch (err) {
    console.log('FAIL: tidak bisa menghubungi CDN -', err.message);
    process.exit(1);
}

ok(res.status === 200, `HTTP 200 (dapat ${res.status})`);

let json = null;
try { json = await res.json(); } catch { /* bukan JSON */ }

ok(json !== null, 'respons berupa JSON');
ok(json && json.success === true, 'respons.success === true');

const url = json && (json.public_url || json.url || json.fix_url || json.user_media_url);
ok(Boolean(url), `respons memuat URL (${url})`);
ok(isAllowed(url), 'URL memakai host CDN yang diizinkan');
ok(Boolean(json && json.filename), `respons memuat filename (${json && json.filename})`);

// Pastikan URL-nya benar-benar bisa diakses publik dan dilayani sebagai gambar
if (url) {
    const head = await fetch(url, { signal: AbortSignal.timeout(30000) });
    ok(head.status === 200, `URL bisa diakses publik (HTTP ${head.status})`);
    const ct = head.headers.get('content-type') || '';
    ok(ct.startsWith('image/'), `dilayani sebagai gambar (content-type: ${ct})`);
    const acao = head.headers.get('access-control-allow-origin');
    ok(acao === '*', `CORS terbuka (access-control-allow-origin: ${acao})`);
    const bytes = Buffer.from(await head.arrayBuffer());
    ok(bytes.length === PNG_1X1.length, `isi file utuh (${bytes.length} byte)`);
}

console.log(`\nFile uji tersimpan sebagai: ${userId}/${filename}`);
console.log(fail === 0 ? '=== TES CDN: SEMUA LULUS ===' : `=== TES CDN: ${fail} GAGAL ===`);
process.exit(fail ? 1 : 0);
