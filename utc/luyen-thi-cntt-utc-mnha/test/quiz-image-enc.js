// Test ảnh câu hỏi MÃ HOÁ: node test/quiz-image-enc.js   (không cần Mongo / GitHub / mạng)
//  1. dịch vụ mã hoá ↔ giải mã   2. bản mã do TRÌNH DUYỆT tạo (Web Crypto, đúng như quizEditor.js) máy chủ giải mã được
//  3. public/js/quizEncImage.js (chạy trong vm với DOM giả) giải mã đúng file do máy chủ mã hoá, xin khoá đúng
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');
const svc = require('../services/quizImageCryptoService');
const moderation = (() => { try { return require('../services/imageModerationService'); } catch (_) { return null; } })();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(3000)]);
let n = 0; const ok = (m) => console.log('  ✓ ' + m, ++n);

(async () => {
    // 1. roundtrip
    const enc = svc.encrypt(PNG);
    assert.ok(enc.subarray(0, 4).equals(Buffer.from('QIM1')));
    assert.ok(!enc.includes(PNG.subarray(0, 16)), 'bản mã không chứa ảnh gốc');
    assert.ok(svc.decrypt(enc).equals(PNG)); ok('máy chủ mã hoá → giải mã đúng');
    const bad = Buffer.from(enc); bad[bad.length - 1] ^= 1;
    assert.throws(() => svc.decrypt(bad), /không giải mã được/); ok('bị sửa 1 bit → từ chối');
    assert.throws(() => svc.decrypt(Buffer.from('xxxx' + 'y'.repeat(100))), /không đúng định dạng/); ok('file lạ → từ chối');
    assert.throws(() => svc.deriveKey('abc'), /Salt/); ok('salt sai → 400');
    if (moderation) { assert.ok(moderation.sniffImage(svc.decrypt(enc))); ok('sau giải mã nhận ra là ảnh (sniffImage)'); }

    // 2. mô phỏng đúng quizEditor.js (trình duyệt mã hoá)
    const subtle = crypto.webcrypto.subtle;
    const b64u = (u) => Buffer.from(u).toString('base64url');
    const MAGIC = new Uint8Array([0x51, 0x49, 0x4d, 0x31]);
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const key = await subtle.importKey('raw', Buffer.from(svc.deriveKey(b64u(salt)), 'base64url'), { name: 'AES-GCM' }, false, ['encrypt']);
    const out = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: MAGIC, tagLength: 128 }, key, PNG));
    const ctLen = out.length - 16, f2 = new Uint8Array(48 + ctLen);
    f2.set(MAGIC, 0); f2.set(salt, 4); f2.set(iv, 20); f2.set(out.subarray(ctLen), 32); f2.set(out.subarray(0, ctLen), 48);
    assert.ok(svc.decrypt(Buffer.from(f2)).equals(PNG)); ok('bản mã do trình duyệt tạo → máy chủ giải mã được');

    // 3. quizEncImage.js trong DOM giả
    const url = 'https://raw.githubusercontent.com/o/r/main/cache/image/1700000000000.enc';
    let keyCalls = 0, blobData = null;
    const img = { tagName: 'IMG', attrs: { src: url }, classList: { add() { }, remove() { } },
        getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; },
        set src(v) { this.attrs.src = v; }, get src() { return this.attrs.src; } };
    const sandbox = {
        console, setTimeout, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        Uint8Array, Blob: class { constructor(p, o) { blobData = { parts: p, type: o && o.type }; } },
        URL: { createObjectURL: () => 'blob:fake' }, MutationObserver: class { observe() { } },
        fetch: async (u, o) => {
            if (u === url) return { ok: true, arrayBuffer: async () => enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.length) };
            if (u === '/api/quiz-image/keys') { keyCalls++; const salts = JSON.parse(o.body).salts; return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, keys: svc.deriveKeys(salts) }) }; }
            throw new Error('fetch lạ ' + u);
        }
    };
    sandbox.window = sandbox; sandbox.crypto = crypto.webcrypto;
    sandbox.document = { body: { nodeType: 1, querySelectorAll: () => [img] }, head: { appendChild() { } }, createElement: () => ({}), addEventListener() { } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/quizEncImage.js'), 'utf8'), sandbox);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(img.attrs.src, 'blob:fake', 'img phải được gán ảnh đã giải mã');
    assert.strictEqual(blobData.type, 'image/png');
    assert.ok(Buffer.from(blobData.parts[0]).equals(PNG)); ok('quizEncImage.js tự giải mã → đúng ảnh gốc (image/png)');
    assert.strictEqual(keyCalls, 1); ok('xin khoá đúng 1 lần');
    assert.ok(sandbox.MnhaQuizEncImage.isEnc(url) && !sandbox.MnhaQuizEncImage.isEnc('https://raw.githubusercontent.com/o/r/main/cache/image/1.png')); ok('chỉ nhận link *.enc');
    console.log('\nTất cả ' + n + ' kiểm tra đạt.');
})().catch((e) => { console.error('✗ LỖI:', e); process.exit(1); });
