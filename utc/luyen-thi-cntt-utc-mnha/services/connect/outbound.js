// services/connect/outbound.js — đếm MỌI dữ liệu web này gửi đi / nhận về từ dịch vụ bên ngoài
// (GitHub, Cloudinary, AI, web dữ liệu khác…) để tính vào trang /connect (cột "Ghi/Đọc ngoài").
//
//   • http / https .request + .get  (Octokit, Cloudinary, axios…)  → đếm byte thật trên socket
//   • global fetch (OpenAI, Gemini, dò web kết nối…)                → body gửi đi + content-length trả về
//
//   Tắt bằng CONNECT_TRACK_OUTBOUND=off (khi đó githubService tự đếm như cũ).
//   Mọi lỗi trong file này đều bị nuốt: đo lưu lượng KHÔNG BAO GIỜ được làm hỏng request thật.
'use strict';
const http = require('http');
const https = require('https');

let active = false;

const isActive = () => active;

function install() {
    if (active || String(process.env.CONNECT_TRACK_OUTBOUND || '').toLowerCase() === 'off') return active;
    const note = (spec) => { try { require('./usage').noteOrigin(spec); } catch (_) { /* chưa sẵn sàng */ } };

    function track(req) {
        let s0 = null, done = false;
        const mark = (sock) => {
            if (!sock || s0) return;
            s0 = { sock, r: Number(sock.bytesRead) || 0, w: Number(sock.bytesWritten) || 0 };
        };
        const finish = () => {
            if (done || !s0) return;
            done = true;
            note({
                in: Math.max(0, (Number(s0.sock.bytesRead) || 0) - s0.r),
                out: Math.max(0, (Number(s0.sock.bytesWritten) || 0) - s0.w)
            });
        };
        if (req.socket) mark(req.socket);
        req.on('socket', mark);
        req.on('response', (res) => { res.once('end', finish); res.once('close', finish); });
        req.once('close', finish);
        req.once('error', finish);
    }

    for (const mod of [http, https]) {
        const orig = mod.request;
        mod.request = function patchedRequest() {
            const req = orig.apply(this, arguments);
            try { track(req); } catch (_) { /* bỏ qua */ }
            return req;
        };
        mod.get = function patchedGet() {
            const req = mod.request.apply(this, arguments);
            req.end();
            return req;
        };
    }

    if (typeof globalThis.fetch === 'function') {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async function patchedFetch(input, init) {
            let out = 0;
            try {
                const b = init && init.body;
                if (typeof b === 'string') out = Buffer.byteLength(b);
                else if (b && typeof b.byteLength === 'number') out = b.byteLength;
                else if (b && typeof b.size === 'number') out = b.size;
            } catch (_) { /* bỏ qua */ }
            let res;
            try { res = await origFetch.apply(this, arguments); } catch (e) { note({ out }); throw e; }
            let inn = 0;
            try { inn = Number(res.headers.get('content-length')) || 0; } catch (_) { /* bỏ qua */ }
            note({ in: inn, out });
            return res;
        };
    }
    active = true;
    return true;
}

module.exports = { install, isActive };
