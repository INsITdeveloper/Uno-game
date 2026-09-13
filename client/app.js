// client/app.js
// Klien Uno: profil pemain, matchmaking, lobby, dan papan permainan.
// Semua validasi tetap di server — klien hanya menampilkan dan mengirim niat.

'use strict';

const AVATARS = [
    'a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07',
    'a08', 'a09', 'a10', 'a11', 'a12', 'a13', 'a14'
];
const PROFILE_KEY = 'uno.profile.v1';
const COLORS = ['RED', 'YELLOW', 'GREEN', 'BLUE'];

// CDN INS (cdnins.insjay.biz.id) untuk avatar hasil upload pemain.
// Wajib HTTPS: halaman game berjalan di HTTPS, permintaan http:// akan diblokir browser.
const CDN = {
    uploadUrl: 'https://cdnins.insjay.biz.id/upload-send',
    allowedHosts: ['cloudins-cdn.insjay.biz.id', 'cdnins.insjay.biz.id'],
    userIdKey: 'uno.cdn.id.v1',
    maxFileBytes: 8 * 1024 * 1024,
    outputSize: 256
};

const $ = (id) => document.getElementById(id);

const el = {
    connState: $('connState'),

    screens: {
        profile: $('screenProfile'),
        home: $('screenHome'),
        search: $('screenSearch'),
        room: $('screenRoom'),
        game: $('screenGame')
    },

    nameInput: $('nameInput'),
    avatarGrid: $('avatarGrid'),
    avatarPreview: $('avatarPreview'),
    avatarPreviewLabel: $('avatarPreviewLabel'),
    uploadAvatarBtn: $('uploadAvatarBtn'),
    clearAvatarBtn: $('clearAvatarBtn'),
    avatarFileInput: $('avatarFileInput'),
    avatarUploadStatus: $('avatarUploadStatus'),
    profileError: $('profileError'),
    saveProfileBtn: $('saveProfileBtn'),

    profileAvatar: $('profileAvatar'),
    profileName: $('profileName'),
    editProfileBtn: $('editProfileBtn'),
    quickMatchBtn: $('quickMatchBtn'),
    botGameBtn: $('botGameBtn'),
    createRoomBtn: $('createRoomBtn'),
    roomCodeInput: $('roomCodeInput'),
    joinRoomBtn: $('joinRoomBtn'),

    searchTitle: $('searchTitle'),
    searchHint: $('searchHint'),
    searchBotBtn: $('searchBotBtn'),
    cancelSearchBtn: $('cancelSearchBtn'),

    roomCodeLabel: $('roomCodeLabel'),
    lobbyPlayers: $('lobbyPlayers'),
    addBotBtn: $('addBotBtn'),
    startGameBtn: $('startGameBtn'),
    leaveRoomBtn: $('leaveRoomBtn'),
    hostHint: $('hostHint'),

    turnIndicator: $('turnIndicator'),
    activeColor: $('activeColor'),
    deckInfo: $('deckInfo'),
    opponents: $('opponents'),
    discardPileTopCard: $('discardPileTopCard'),
    drawPile: $('drawPile'),
    playerHand: document.querySelector('.hand-cards'),
    playSelectedBtn: $('playSelectedBtn'),
    handHint: $('handHint'),
    penaltyBanner: $('penaltyBanner'),
    rulesToggle: $('rulesToggle'),
    rulesHint: $('rulesHint'),
    rematchBtn: $('rematchBtn'),
    leaveGameBtn: $('leaveGameBtn'),

    chatPanel: $('chatPanel'),
    chatLog: $('chatLog'),
    chatForm: $('chatForm'),
    chatInput: $('chatInput'),
    chatSendBtn: $('chatSendBtn'),

    gameMessages: $('gameMessages'),
    colorPicker: $('colorPicker'),
    cancelColorBtn: $('cancelColorBtn')
};

const app = {
    socket: null,
    connected: false,
    localPlayerId: 'player_' + Math.random().toString(36).slice(2, 9),
    profile: null,
    pickingAvatar: null,
    pickingAvatarUrl: null,
    roomCode: null,
    playerList: [],
    hostId: null,
    game: null,
    gameRunning: false,
    isMyTurn: false,
    autoBot: false,   // true = setelah room dibuat, langsung tambah bot & mulai
    screen: null,
    rules: { multiPlay: false, stacking: false },
    selected: [],       // daftar "warna|tipe" kartu yang sedang dipilih
    skipIncomingAnim: false  // true = animasi lempar sudah dijalankan sendiri
};

/** Aturan efektif: state game lebih baru daripada state lobby. */
function activeRules() {
    return (app.game && app.game.rules) || app.rules || { multiPlay: false, stacking: false };
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function avatarSrc(id) {
    return `assets/avatars/${AVATARS.includes(id) ? id : 'fallback'}.png`;
}

/**
 * Identitas pemilik file di CDN. Tidak ada autentikasi di CDN-nya, jadi ID ini
 * berlaku seperti kunci: acak 16 hex per browser supaya tidak mudah ditebak
 * atau bertabrakan dengan pemain lain.
 */
function cdnUserId() {
    let id = null;
    try { id = localStorage.getItem(CDN.userIdKey); } catch { /* localStorage bisa diblokir */ }
    if (id && /^uno-[a-f0-9]{16}$/.test(id)) return id;

    const bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);

    id = 'uno-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(CDN.userIdKey, id); } catch { /* diabaikan */ }
    return id;
}

/** Hanya URL dari host CDN yang kita kenal yang boleh dipakai sebagai avatar. */
function isAllowedAvatarUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && CDN.allowedHosts.includes(u.hostname);
    } catch {
        return false;
    }
}

/**
 * Pasang gambar avatar ke sebuah <img>, dengan fallback otomatis ke avatar
 * bawaan kalau URL custom-nya gagal dimuat.
 * @param {HTMLImageElement} img
 * @param {{avatar?:string, avatarUrl?:string}|string} source
 */
function applyAvatar(img, source) {
    const presetId = source && typeof source === 'object' ? source.avatar : source;
    const custom = source && typeof source === 'object' ? source.avatarUrl : null;
    const fallback = avatarSrc(presetId);

    img.onerror = () => {
        img.onerror = null;
        img.src = fallback;
    };
    img.src = custom && isAllowedAvatarUrl(custom) ? custom : fallback;
    return img;
}

/** Bungkus avatar dalam cincin bulat ala game. */
function avatarRing(source) {
    const ring = document.createElement('div');
    ring.className = 'avatar-ring';
    const img = document.createElement('img');
    applyAvatar(img, source);
    img.alt = '';
    ring.appendChild(img);
    return ring;
}

function setAvatarStatus(text, kind = 'info') {
    el.avatarUploadStatus.textContent = text;
    el.avatarUploadStatus.className = 'hint upload-' + kind;
}

/** Potong tengah + perkecil file gambar jadi JPEG persegi 256x256. */
function fileToAvatarBlob(file, size = CDN.outputSize) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            try {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingQuality = 'high';

                const scale = Math.max(size / img.width, size / img.height);
                const w = img.width * scale;
                const h = img.height * scale;
                ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);

                canvas.toBlob(
                    (blob) => (blob ? resolve(blob) : reject(new Error('Gagal memproses gambar.'))),
                    'image/jpeg',
                    0.86
                );
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('File itu bukan gambar yang bisa dibaca.'));
        };
        img.src = objectUrl;
    });
}

/** Kirim gambar ke CDN INS dan kembalikan URL publiknya. */
function uploadAvatar(blob) {
    return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', blob, 'avatar.jpg');

        const xhr = new XMLHttpRequest();
        xhr.open('POST', CDN.uploadUrl);
        xhr.setRequestHeader('x-user-id', cdnUserId());
        xhr.setRequestHeader('x-filename', `avatar-${Date.now()}.jpg`);
        xhr.timeout = 45000;

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                setAvatarStatus(`Mengunggah\u2026 ${Math.round((e.loaded / e.total) * 100)}%`, 'info');
            }
        };

        xhr.onload = () => {
            let res = null;
            try { res = JSON.parse(xhr.responseText); } catch { /* respons bukan JSON */ }

            const body = res && typeof res === 'object' ? (res.data || res) : {};
            const url = body.public_url || body.url || body.fileUrl || body.fix_url ||
                body.user_media_url || body.path || null;

            if (xhr.status === 200 && body.success !== false && url) {
                if (!isAllowedAvatarUrl(url)) {
                    reject(new Error('CDN mengembalikan URL yang tidak dikenali.'));
                    return;
                }
                resolve(String(url));
            } else {
                const msg = (res && (res.message || res.error)) || `Upload gagal (HTTP ${xhr.status}).`;
                reject(new Error(msg));
            }
        };
        xhr.onerror = () => reject(new Error('Tidak bisa menghubungi CDN.'));
        xhr.ontimeout = () => reject(new Error('Upload timeout. Coba lagi.'));

        xhr.send(form);
    });
}

async function handleAvatarFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        setAvatarStatus('File harus berupa gambar (JPG/PNG/WebP).', 'error');
        return;
    }
    if (file.size > CDN.maxFileBytes) {
        setAvatarStatus('Ukuran file maksimal 8 MB.', 'error');
        return;
    }

    el.uploadAvatarBtn.disabled = true;
    setAvatarStatus('Memproses gambar\u2026', 'info');
    try {
        const blob = await fileToAvatarBlob(file);
        const url = await uploadAvatar(blob);
        app.pickingAvatarUrl = url;
        renderAvatarPreview();
        renderAvatarGrid();
        setAvatarStatus('Avatar tersimpan di CDN. \u2714', 'ok');
    } catch (err) {
        setAvatarStatus(err.message || 'Upload gagal.', 'error');
    } finally {
        el.uploadAvatarBtn.disabled = false;
        el.avatarFileInput.value = '';
    }
}

function renderAvatarPreview() {
    const hasCustom = Boolean(app.pickingAvatarUrl);
    applyAvatar(el.avatarPreview, { avatar: app.pickingAvatar, avatarUrl: app.pickingAvatarUrl });
    el.avatarPreviewLabel.textContent = hasCustom ? 'Foto kamu' : 'Avatar bawaan';
    el.clearAvatarBtn.hidden = !hasCustom;
}

function isHost() {
    return Boolean(app.hostId) && app.hostId === app.localPlayerId;
}

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

function appendChat(msg) {
    const mine = msg.playerId === app.localPlayerId;
    const line = document.createElement('div');
    line.className = 'chat-line' + (mine ? ' mine' : '');

    line.appendChild(avatarRing({ avatar: msg.avatar, avatarUrl: msg.avatarUrl }));

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    const author = document.createElement('span');
    author.className = 'chat-author';
    author.textContent = mine ? 'Kamu' : (msg.name || '?') + (msg.isBot ? ' 🤖' : '');

    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = msg.text;

    bubble.appendChild(author);
    bubble.appendChild(text);
    line.appendChild(bubble);
    el.chatLog.appendChild(line);

    // batasi riwayat supaya tidak tumbuh tanpa henti
    while (el.chatLog.children.length > 60) {
        el.chatLog.removeChild(el.chatLog.firstChild);
    }
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

// --- Pilih beberapa kartu -------------------------------------------------

function toggleSelect(card) {
    const key = `${card.color}|${card.type}`;
    const i = app.selected.indexOf(key);

    if (i !== -1) {
        app.selected.splice(i, 1);
        renderGame();
        return;
    }

    // Kartu yang boleh keluar bersamaan harus sejenis. Kalau yang ditabuh beda
    // jenis, mulai pilihan baru dari kartu itu.
    if (app.selected.length > 0) {
        const firstType = app.selected[0].split('|')[1];
        if (firstType !== card.type) app.selected = [];
    }

    app.selected.push(key);
    renderGame();
}

/** Ubah daftar pilihan jadi objek kartu nyata yang diambil dari tangan. */
function resolveSelectedCards() {
    const game = app.game || {};
    const pool = [...(game.playerHand || [])];
    const topCard = game.discardPile && game.discardPile.length
        ? game.discardPile[game.discardPile.length - 1]
        : null;

    const out = [];
    for (const key of app.selected) {
        const [color, type] = key.split('|');
        const idx = pool.findIndex((c) => c.color === color && c.type === type);
        if (idx === -1) continue;
        out.push({ color: pool[idx].color, type: pool[idx].type });
        pool.splice(idx, 1);
    }

    // Server mewajibkan kartu PERTAMA sah dimainkan sendiri. Jadi kartu yang
    // cocok dengan meja ditaruh di depan, supaya susunan pilihan tidak jadi soal.
    out.sort((a, b) => Number(isCardPlayable(b, topCard, game.currentColor)) -
                       Number(isCardPlayable(a, topCard, game.currentColor)));
    return out;
}

// --- Animasi kartu dilempar ke meja ---------------------------------------

function flyCardToPile(card, from, to, delay = 0) {
    const img = document.createElement('img');
    img.src = `assets/cards/${cardImageName(card)}`;
    img.alt = '';
    img.className = 'fly-card';
    img.style.left = `${from.left}px`;
    img.style.top = `${from.top}px`;
    img.style.width = `${from.width}px`;
    img.style.height = `${from.height}px`;
    img.style.transitionDelay = `${delay}ms`;
    document.body.appendChild(img);

    requestAnimationFrame(() => {
        img.style.left = `${to.left}px`;
        img.style.top = `${to.top}px`;
        img.style.width = `${to.width}px`;
        img.style.height = `${to.height}px`;
        img.style.transform = 'rotate(340deg) scale(1) scaleX(-1)';
    });
    setTimeout(() => img.remove(), 560 + delay);
}

/** Terbangkan beberapa kartu dari titik asal ke tumpukan buangan. */
function flyCards(cards, sources) {
    const target = el.discardPileTopCard.getBoundingClientRect();
    if (!target.width || !sources.length) return;
    cards.forEach((card, i) => {
        const src = sources[i] || sources[sources.length - 1];
        if (!src) return;
        const from = typeof src.getBoundingClientRect === 'function' ? src.getBoundingClientRect() : src;
        flyCardToPile(card, from, target, i * 90);
    });
}

async function sendPlay(cards, sources = []) {
    if (!app.isMyTurn) {
        showMessage('Belum giliranmu.', 'warning');
        return;
    }
    if (!cards.length) return;

    let chosenColor = null;
    if (cards.some((c) => c.color === 'WILD')) {
        chosenColor = await pickColor();
        if (!chosenColor) {
            showMessage('Pemilihan warna dibatalkan.', 'warning');
            return;
        }
    }

    // Kartu yang dipilih diambil elemennya untuk dianimasikan melempar.
    const from = sources.length
        ? sources
        : Array.from(el.playerHand.querySelectorAll('.card.image-card.selected'));

    app.selected = [];
    app.skipIncomingAnim = true;   // jangan animasi dua kali dari update server
    flyCards(cards, from);
    send({ type: 'PLAY_CARD', cards, chosenColor });
}

/**
 * Tap pada kartu: kalau ada kartu sejenis di tangan, masuk mode pilih supaya
 * bisa keluar beberapa sekaligus. Kalau tidak ada, langsung main seperti biasa.
 */
function onCardTap(card, node) {
    const rules = activeRules();
    const hand = (app.game && app.game.playerHand) || [];
    const sejenis = hand.filter((c) => c.type === card.type && c.color !== 'WILD').length > 1;

    if (rules.multiPlay && card.color !== 'WILD' && (app.selected.length > 0 || sejenis)) {
        toggleSelect(card);
        return;
    }
    sendPlay([{ color: card.color, type: card.type }], node ? [node] : []);
}

function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    if (!send({ type: 'CHAT_SEND', text })) return;
    el.chatInput.value = '';
    el.chatInput.focus();
}

function setConn(text, type = 'info') {
    el.connState.textContent = text;
    el.connState.className = 'conn ' + type;
}

function colorLabel(color) {
    return { RED: 'Merah', YELLOW: 'Kuning', GREEN: 'Hijau', BLUE: 'Biru' }[color] || color || '-';
}

function getCardDisplayValue(type) {
    switch (type) {
        case 'SKIP': return 'skip';
        case 'REVERSE': return 'reverse';
        case 'DRAW_TWO': return '+2';
        case 'WILD': return 'wild';
        case 'WILD_DRAW_FOUR': return '+4';
        default: return String(type);
    }
}

/** Salinan aturan untuk highlight saja; server tetap penentu akhir. */
function isCardPlayable(card, topCard, currentColor) {
    if (!topCard) return true;
    if (card.color === 'WILD') return true;
    if (card.color === currentColor) return true;
    if (card.type === topCard.type) return true;
    return false;
}

/**
 * Boleh dipilih atau tidak.
 *
 * Saat aturan rumahan nyala, kartu yang TIDAK cocok dengan meja tetap boleh
 * dipilih kalau ada kartu sejenis di tangan yang cocok — karena nanti dia ikut
 * keluar bersamaan. Contoh: meja RED 6, tangan punya RED 3 dan GREEN 3;
 * GREEN 3 tidak cocok warna, tapi boleh ikut menemani RED 3.
 */
function isCardSelectable(card, hand, topCard, currentColor) {
    if (isCardPlayable(card, topCard, currentColor)) return true;
    if (card.color === 'WILD') return false;
    return hand.some((c) => c !== card && c.type === card.type &&
        isCardPlayable(c, topCard, currentColor));
}

// ---------------------------------------------------------------------------
// Navigasi layar
// ---------------------------------------------------------------------------

function showScreen(name) {
    app.screen = name;
    Object.entries(el.screens).forEach(([key, node]) => {
        node.hidden = key !== name;
    });
    // Obrolan hanya muncul saat sudah berada di sebuah room
    const inRoom = Boolean(app.roomCode) && (name === 'room' || name === 'game');
    el.chatPanel.hidden = !inRoom;
    if (inRoom) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

function loadProfile() {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (!p || typeof p.name !== 'string' || !p.name.trim()) return null;
        const avatarUrl = typeof p.avatarUrl === 'string' && isAllowedAvatarUrl(p.avatarUrl)
            ? p.avatarUrl
            : null;
        return {
            name: p.name.slice(0, 16),
            avatar: AVATARS.includes(p.avatar) ? p.avatar : 'a01',
            avatarUrl
        };
    } catch {
        return null;
    }
}

function persistProfile(profile) {
    try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
        /* localStorage bisa diblokir; profil tetap dipakai di sesi ini */
    }
}

function renderAvatarGrid() {
    el.avatarGrid.innerHTML = '';
    AVATARS.forEach((id) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-choice';
        btn.dataset.avatar = id;
        btn.setAttribute('aria-label', 'Avatar ' + id);
        const img = document.createElement('img');
        img.src = avatarSrc(id);
        img.alt = '';
        btn.appendChild(img);
        btn.addEventListener('click', () => {
            app.pickingAvatar = id;
            app.pickingAvatarUrl = null;
            renderAvatarGrid();
            renderAvatarPreview();
            setAvatarStatus('Memakai avatar bawaan.', 'info');
        });
        if (app.pickingAvatar === id && !app.pickingAvatarUrl) btn.classList.add('selected');
        el.avatarGrid.appendChild(btn);
    });
}

function openProfileScreen(prefill) {
    if (!app.pickingAvatar) app.pickingAvatar = (prefill && prefill.avatar) || AVATARS[0];
    app.pickingAvatarUrl = (prefill && prefill.avatarUrl) || null;
    el.nameInput.value = (prefill && prefill.name) || '';
    el.profileError.hidden = true;
    setAvatarStatus('JPG/PNG/WebP, otomatis dipotong ke 256\u00d7256.', 'info');
    renderAvatarGrid();
    renderAvatarPreview();
    showScreen('profile');
    el.nameInput.focus();
}

function submitProfile() {
    const name = el.nameInput.value.replace(/\s+/g, ' ').trim();
    if (!name) {
        el.profileError.textContent = 'Nama tidak boleh kosong.';
        el.profileError.hidden = false;
        return;
    }
    if (name.length > 16) {
        el.profileError.textContent = 'Nama maksimal 16 karakter.';
        el.profileError.hidden = false;
        return;
    }

    app.profile = {
        name,
        avatar: app.pickingAvatar || AVATARS[0],
        avatarUrl: app.pickingAvatarUrl || null
    };
    persistProfile(app.profile);
    renderHome();
    showScreen('home');
    if (app.roomCode) {
        // Sudah berada di room (mis. setelah reconnect) — kembali ke lobby
        showScreen(app.gameRunning ? 'game' : 'room');
    }
}

function renderHome() {
    el.profileName.textContent = app.profile.name;
    applyAvatar(el.profileAvatar, app.profile);
}

// ---------------------------------------------------------------------------
// Render lobby
// ---------------------------------------------------------------------------

function renderLobby() {
    el.roomCodeLabel.textContent = app.roomCode || '-----';
    el.lobbyPlayers.innerHTML = '';

    app.playerList.forEach((p, i) => {
        const card = document.createElement('div');
        card.className = 'player-card';
        if (p.id === app.hostId) card.classList.add('is-host');
        if (p.id === app.localPlayerId) card.classList.add('is-me');
        if (p.isBot) card.classList.add('is-bot');

        card.appendChild(avatarRing(p));

        const info = document.createElement('div');
        info.className = 'pc-info';
        const nm = document.createElement('strong');
        nm.textContent = p.name + (p.id === app.localPlayerId ? ' (kamu)' : '');
        const tag = document.createElement('span');
        tag.className = 'tag' + (p.isBot ? ' bot' : (p.id === app.hostId ? ' host' : ''));
        tag.textContent = p.isBot ? 'BOT' : (p.id === app.hostId ? 'HOST' : 'Pemain ' + (i + 1));
        info.appendChild(nm);
        info.appendChild(tag);
        card.appendChild(info);

        if (isHost() && p.isBot) {
            const del = document.createElement('button');
            del.className = 'link danger';
            del.textContent = 'Hapus';
            del.addEventListener('click', () => send({ type: 'REMOVE_BOT', botId: p.id }));
            card.appendChild(del);
        }

        el.lobbyPlayers.appendChild(card);
    });

    const host = isHost();
    el.rulesToggle.checked = Boolean(app.rules.multiPlay);
    el.rulesToggle.disabled = !host;
    el.rulesHint.hidden = host;

    const botCount = app.playerList.filter((p) => p.isBot).length;
    el.addBotBtn.disabled = !host || botCount >= 3 || app.playerList.length >= 10;
    el.startGameBtn.disabled = !host || app.playerList.length < 2;
    el.hostHint.hidden = host;
    el.startGameBtn.textContent = app.playerList.length < 2 ? 'Butuh 2 pemain' : 'Mulai Game';
}

// ---------------------------------------------------------------------------
// Render kartu & papan
// ---------------------------------------------------------------------------

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
        cardEl.addEventListener('click', () => onClick(cardEl));
    } else {
        cardEl.classList.add('dim');
    }

    return cardEl;
}

function renderGame() {
    const game = app.game;
    if (!game) {
        el.turnIndicator.textContent = 'Menunggu…';
        el.activeColor.textContent = '';
        el.deckInfo.textContent = '';
        el.opponents.innerHTML = '';
        el.playerHand.innerHTML = '';
        el.discardPileTopCard.innerHTML = '';
        el.drawPile.classList.remove('can-draw');
        el.rematchBtn.hidden = true;
        el.playSelectedBtn.hidden = true;
        el.handHint.hidden = true;
        el.penaltyBanner.hidden = true;
        return;
    }

    const topCard = game.discardPile && game.discardPile.length
        ? game.discardPile[game.discardPile.length - 1]
        : null;

    el.discardPileTopCard.innerHTML = '';
    if (topCard) {
        el.discardPileTopCard.appendChild(createCardElement(topCard, { small: true }));
    } else {
        el.discardPileTopCard.innerHTML = '<div class="card small empty"></div>';
    }

    const isMyTurn = game.currentPlayerId === app.localPlayerId;
    app.isMyTurn = isMyTurn && game.winner === null;

    const current = (game.players || []).find((p) => p.id === game.currentPlayerId);
    el.turnIndicator.innerHTML = '';
    if (game.winner !== null) {
        el.turnIndicator.textContent = '🏁 Game selesai';
    } else if (isMyTurn) {
        el.turnIndicator.textContent = '⭐ GILIRAN KAMU';
    } else if (current) {
        el.turnIndicator.appendChild(avatarRing(current));
        const who = document.createElement('span');
        who.textContent = `Giliran ${current.name}`;
        el.turnIndicator.appendChild(who);
    } else {
        el.turnIndicator.textContent = 'Menunggu…';
    }
    el.turnIndicator.classList.toggle('mine', isMyTurn && game.winner === null);

    el.activeColor.textContent = colorLabel(game.currentColor);
    el.deckInfo.textContent =
        `Ambil kartu · ${game.deckCount}` + (game.direction === -1 ? ' ↺' : '');

    // Cahaya di tumpukan buangan mengikuti warna aktif
    const glow = {
        RED: 'rgba(255,107,107,.5)',
        YELLOW: 'rgba(255,217,100,.5)',
        GREEN: 'rgba(86,217,138,.5)',
        BLUE: 'rgba(90,168,245,.5)'
    }[game.currentColor] || 'transparent';
    el.discardPileTopCard.style.setProperty('--glow', glow);

    // Kursi lawan di sekeliling meja
    el.opponents.innerHTML = '';
    (game.players || []).forEach((p) => {
        if (p.isYou) return;

        const seat = document.createElement('div');
        seat.className = 'seat';
        seat.dataset.playerId = p.id;
        if (p.id === game.currentPlayerId) seat.classList.add('active');
        if (p.count === 0) seat.classList.add('out');

        seat.appendChild(avatarRing(p));

        const nm = document.createElement('span');
        nm.className = 'seat-name';
        nm.textContent = p.name + (p.isBot ? ' 🤖' : '');
        seat.appendChild(nm);

        const line = document.createElement('div');
        line.className = 'seat-cards';
        if (p.count > 0) {
            const mini = document.createElement('div');
            mini.className = 'mini-stack';
            for (let i = 0; i < Math.min(p.count, 5); i++) mini.appendChild(document.createElement('i'));
            line.appendChild(mini);
        }
        const badge = document.createElement('span');
        badge.className = 'count-badge';
        badge.textContent = `${p.count} kartu`;
        line.appendChild(badge);
        seat.appendChild(line);

        el.opponents.appendChild(seat);
    });

    // Tangan sendiri — kartu dikipas seperti sedang dipegang
    el.playerHand.innerHTML = '';
    const hand = game.playerHand || [];
    const n = hand.length;
    const mid = (n - 1) / 2;
    const overlap = n <= 8 ? 16 : (n <= 12 ? 28 : 38);
    el.playerHand.style.setProperty('--overlap', `${overlap}px`);

    // Hitung berapa kartu per jenis yang sedang dipilih (untuk kartu kembar)
    const selectedCount = {};
    for (const k of app.selected) selectedCount[k] = (selectedCount[k] || 0) + 1;
    const usedSoFar = {};

    hand.forEach((card, index) => {
        const key = `${card.color}|${card.type}`;
        const isSelected = (usedSoFar[key] || 0) < (selectedCount[key] || 0);
        if (isSelected) usedSoFar[key] = (usedSoFar[key] || 0) + 1;

        const bisaMulti = activeRules().multiPlay;
        const playable = game.winner === null && isMyTurn &&
            (bisaMulti
                ? isCardSelectable(card, hand, topCard, game.currentColor)
                : isCardPlayable(card, topCard, game.currentColor));
        const cardEl = createCardElement(card, { playable, onClick: (node) => onCardTap(card, node) });
        if (isSelected) cardEl.classList.add('selected');

        const d = index - mid;
        const rot = Math.min(Math.abs(d), 6) * (d < 0 ? -1 : 1) * 3;
        cardEl.style.setProperty('--rot', `${rot.toFixed(2)}deg`);
        cardEl.style.setProperty('--lift', `${(Math.abs(d) * 4).toFixed(1)}px`);
        cardEl.style.setProperty('--z', String(index + 1));
        cardEl.classList.add('deal-in');
        cardEl.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
        cardEl.dataset.cardIndexInHand = index;
        el.playerHand.appendChild(cardEl);
    });

    // Mengambil kartu dilakukan dengan menekan tumpukan — tidak ada tombol kedua.
    el.drawPile.classList.toggle('can-draw', app.isMyTurn);
    el.rematchBtn.hidden = !(game.winner !== null && isHost());

    // Tombol mainkan hanya muncul saat ada kartu yang dipilih
    const picked = app.selected.length;
    el.playSelectedBtn.hidden = picked === 0;
    el.playSelectedBtn.disabled = !app.isMyTurn;
    el.playSelectedBtn.textContent = picked > 1 ? `Mainkan (${picked} kartu)` : 'Mainkan';
    el.handHint.hidden = !(activeRules().multiPlay && picked === 0 && isMyTurn && game.winner === null);

    // Peringatan hukuman menggantung
    if (game.pendingDraw > 0) {
        el.penaltyBanner.hidden = false;
        el.penaltyBanner.textContent = isMyTurn
            ? `Hukuman ${game.pendingDraw} kartu — tumpuk +2/+4, atau tekan tumpukan untuk mengambil`
            : `Hukuman ${game.pendingDraw} kartu menunggu`;
    } else {
        el.penaltyBanner.hidden = true;
    }
}

// ---------------------------------------------------------------------------
// Aksi pemain
// ---------------------------------------------------------------------------

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

function drawCard() {
    if (!app.isMyTurn) {
        showMessage('Belum giliranmu.', 'warning');
        return;
    }
    send({ type: 'DRAW_CARD' });
}

// ---------------------------------------------------------------------------
// Event listener
// ---------------------------------------------------------------------------

el.drawPile.addEventListener('click', drawCard);

el.saveProfileBtn.addEventListener('click', submitProfile);
el.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitProfile();
});
el.editProfileBtn.addEventListener('click', () => openProfileScreen(app.profile));

el.playSelectedBtn.addEventListener('click', () => {
    const nodes = Array.from(el.playerHand.querySelectorAll('.card.image-card.selected'));
    const cards = resolveSelectedCards();
    if (!cards.length) {
        app.selected = [];
        renderGame();
        return;
    }
    sendPlay(cards, nodes);
});

// Aturan rumahan (khusus pembuat room)
el.rulesToggle.addEventListener('change', () => {
    send({ type: 'SET_RULES', multiPlay: el.rulesToggle.checked, stacking: el.rulesToggle.checked });
});

// Upload avatar sendiri ke CDN INS
el.uploadAvatarBtn.addEventListener('click', () => el.avatarFileInput.click());
el.avatarFileInput.addEventListener('change', (e) => {
    handleAvatarFile(e.target.files && e.target.files[0]);
});
el.clearAvatarBtn.addEventListener('click', () => {
    app.pickingAvatarUrl = null;
    renderAvatarPreview();
    renderAvatarGrid();
    setAvatarStatus('Kembali memakai avatar bawaan.', 'info');
});

el.quickMatchBtn.addEventListener('click', () => {
    if (send({ type: 'FIND_MATCH', playerId: app.localPlayerId, profile: app.profile })) {
        el.searchTitle.textContent = 'Mencari lawan…';
        el.searchHint.textContent = 'Menunggu pemain lain bergabung.';
        showScreen('search');
    }
});

el.botGameBtn.addEventListener('click', () => {
    app.autoBot = true;
    if (send({ type: 'CREATE_ROOM', playerId: app.localPlayerId, profile: app.profile })) {
        setConn('Menyiapkan room bot…', 'info');
    }
});

el.createRoomBtn.addEventListener('click', () => {
    app.autoBot = false;
    send({ type: 'CREATE_ROOM', playerId: app.localPlayerId, profile: app.profile });
});

el.joinRoomBtn.addEventListener('click', () => {
    const code = el.roomCodeInput.value.trim().toUpperCase();
    if (!code) {
        showMessage('Masukkan kode room dulu.', 'warning');
        return;
    }
    send({ type: 'JOIN_ROOM', roomCode: code, playerId: app.localPlayerId, profile: app.profile });
});
el.roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.joinRoomBtn.click();
});

el.cancelSearchBtn.addEventListener('click', () => send({ type: 'CANCEL_MATCH' }));
el.searchBotBtn.addEventListener('click', () => {
    app.autoBot = true;
    send({ type: 'CANCEL_MATCH' });
});

el.addBotBtn.addEventListener('click', () => send({ type: 'ADD_BOT' }));
el.startGameBtn.addEventListener('click', () => send({ type: 'START_GAME' }));
el.leaveRoomBtn.addEventListener('click', () => send({ type: 'LEAVE_ROOM' }));
el.leaveGameBtn.addEventListener('click', () => send({ type: 'LEAVE_ROOM' }));
el.rematchBtn.addEventListener('click', () => send({ type: 'START_GAME' }));

el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    app.socket = new WebSocket(`${protocol}//${window.location.host}/websocket`);

    app.socket.addEventListener('open', () => {
        app.connected = true;
        setConn('tersambung', 'ok');
    });

    app.socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            console.warn('Pesan bukan JSON:', event.data);
            return;
        }
        handleServerMessage(message);
    });

    app.socket.addEventListener('close', () => {
        app.connected = false;
        setConn('terputus', 'bad');
        showMessage('Koneksi ke server terputus. Muat ulang halaman.', 'error');
        app.roomCode = null;
        app.gameRunning = false;
        app.game = null;
    });

    app.socket.addEventListener('error', () => {
        setConn('error', 'bad');
        showMessage('Terjadi kesalahan pada koneksi WebSocket.', 'error');
    });
}

function resetToHome() {
    app.roomCode = null;
    app.playerList = [];
    app.hostId = null;
    app.game = null;
    app.gameRunning = false;
    app.isMyTurn = false;
    app.autoBot = false;
    el.chatLog.innerHTML = '';
    app.selected = [];
    app.rules = { multiPlay: false, stacking: false };
    renderGame();
    showScreen('home');
}

function handleServerMessage(message) {
    switch (message.type) {
        // ---------------------------------------------------------- LOBBY
        case 'ROOM_CREATED':
            app.roomCode = message.roomCode;
            app.playerList = message.playerList || [];
            app.hostId = message.hostId;
            app.rules = message.rules || app.rules;
            app.game = null;
            app.gameRunning = false;
            showMessage(`Room dibuat: ${message.roomCode}`, 'success');
            setConn('di room ' + message.roomCode, 'info');
            renderLobby();
            showScreen('room');
            if (app.autoBot) send({ type: 'ADD_BOT' });
            break;

        case 'ROOM_JOINED':
            app.roomCode = message.roomCode;
            app.playerList = message.playerList || [];
            app.hostId = message.hostId;
            app.rules = message.rules || app.rules;
            app.game = null;
            app.gameRunning = false;
            showMessage(`Bergabung ke room ${message.roomCode}.`, 'success');
            setConn('di room ' + message.roomCode, 'info');
            renderLobby();
            showScreen('room');
            break;

        case 'ROOM_UPDATE':
            app.playerList = message.playerList || [];
            app.hostId = message.hostId;
            app.rules = message.rules || app.rules;
            renderLobby();
            if (app.autoBot && app.playerList.length >= 2) {
                app.autoBot = false;
                send({ type: 'START_GAME' });
            }
            break;

        case 'PLAYER_LEFT':
            app.playerList = message.playerList || [];
            renderLobby();
            break;

        // ---------------------------------------------------- MATCHMAKING
        case 'MATCH_SEARCHING':
            el.searchTitle.textContent = 'Mencari lawan…';
            el.searchHint.textContent = 'Menunggu pemain lain bergabung.';
            showScreen('search');
            break;

        case 'MATCH_FOUND':
            app.roomCode = message.roomCode;
            app.playerList = message.playerList || [];
            app.hostId = message.hostId;
            showMessage(`Lawan ditemukan! Room ${message.roomCode}`, 'success');
            setConn('di room ' + message.roomCode, 'info');
            renderLobby();
            break;

        case 'MATCH_BOT_FILLED':
            showMessage(message.message, 'warning');
            break;

        case 'MATCH_CANCELLED':
            showMessage('Pencarian dibatalkan.', 'info');
            if (app.autoBot) {
                setConn('Menyiapkan room bot…', 'info');
                send({ type: 'CREATE_ROOM', playerId: app.localPlayerId, profile: app.profile });
            } else {
                resetToHome();
            }
            break;

        // ----------------------------------------------------------- GAME
        case 'GAME_STARTED':
            app.gameRunning = true;
            setConn('bermain di ' + app.roomCode, 'ok');
            showMessage(message.message, 'success');
            showScreen('game');
            renderGame();
            break;

        case 'GAME_STATE_UPDATE': {
            const prevGame = app.game;
            // Titik asal animasi lempar untuk kartu lawan (kursi yang tadi jalan)
            let seatFrom = null;
            if (prevGame && prevGame.currentPlayerId && prevGame.currentPlayerId !== app.localPlayerId) {
                const seatEl = el.opponents.querySelector(
                    `.seat[data-player-id="${prevGame.currentPlayerId}"]`);
                if (seatEl) seatFrom = seatEl.getBoundingClientRect();
            }

            app.game = message.gameState;
            app.selected = [];   // indeks kartu bergeser, pilihan lama tidak valid lagi
            (message.gameState.messages || []).forEach((m) => showMessage(m.text, m.type));
            if (!app.gameRunning) {
                app.gameRunning = true;
                showScreen('game');
            }
            renderGame();

            // Animasi kartu lawan dilempar ke meja
            if (!app.skipIncomingAnim && prevGame && seatFrom) {
                const before = (prevGame.discardPile || []).length;
                const pile = app.game.discardPile || [];
                if (pile.length > before) {
                    const target = el.discardPileTopCard.getBoundingClientRect();
                    pile.slice(before).forEach((card, i) =>
                        flyCardToPile(card, seatFrom, target, i * 90));
                }
            }
            app.skipIncomingAnim = false;
            break;
        }

        case 'GAME_OVER':
            app.gameRunning = false;
            if (app.game) app.game = { ...app.game, winner: message.winnerId };
            showMessage(message.message, 'success');
            if (!message.isBot && message.winnerId === app.localPlayerId) {
                showMessage('Selamat, kamu menang! 🎉', 'success');
            }
            renderGame();
            break;

        case 'GAME_ABORTED':
            app.gameRunning = false;
            app.game = null;
            showMessage(message.message, 'warning');
            renderGame();
            if (app.roomCode) {
                renderLobby();
                showScreen('room');
            } else {
                resetToHome();
            }
            break;

        // --------------------------------------------------------- LAINNYA
        case 'CHAT_MESSAGE':
            appendChat(message);
            break;

        case 'ERROR':
            showMessage('Error: ' + message.message, 'error');
            if (app.autoBot && /room|bot|pemain/i.test(message.message)) app.autoBot = false;
            break;

        default:
            console.warn('Tipe pesan tidak dikenal:', message.type);
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

connect();

const saved = loadProfile();
if (saved) {
    app.profile = saved;
    app.pickingAvatar = saved.avatar;
    app.pickingAvatarUrl = saved.avatarUrl || null;
    renderHome();
    showScreen('home');
} else {
    openProfileScreen(null);
}

// Untuk debugging di console browser
window.unoApp = app;
