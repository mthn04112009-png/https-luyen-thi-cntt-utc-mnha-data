/* directImage.js — up ảnh THẲNG từ trình duyệt: Cloudinary (kiểm duyệt) → GitHub, không đưa bytes ảnh qua máy chủ.
 *
 *   MnhaDirectImage.run({
 *     base,      '/admin/quiz/upload-image' (ảnh câu hỏi / flashcard)  hoặc  '/submissions/drawing-upload' (ảnh viết tay)
 *     file,      File/Blob ảnh người dùng chọn
 *     names,     mảng CLOUDINARY_CLOUD_NAME đã chọn
 *     maxBytes,  giới hạn dung lượng của Cloudinary (nén ảnh nếu lớn hơn)
 *     compress,  (file, limit) => Promise<Blob>  — hàm nén sẵn có của trang (tuỳ chọn)
 *     status,    (text) => void                   — cập nhật dòng trạng thái (tuỳ chọn)
 *     legacy     () => Promise<data>              — luồng CŨ qua máy chủ, dùng khi không up thẳng được
 *   }) → Promise<data>   data có cùng dạng với luồng cũ: quiz {url,path,mime,bytes,moderatedBy,warning} · drawing {token,mime,bytes}
 *
 * 5 bước (xem services/directImageService.js): init → POST thẳng Cloudinary → verify (máy chủ hỏi lại Cloudinary rồi cấp token tạm GitHub)
 *   → PUT thẳng api.github.com → done (máy chủ so ảnh đã lưu với ảnh đã duyệt).
 * Lỗi hạ tầng (Cloudinary/GitHub/CORS/token/mạng/chưa cấu hình GitHub App) → tự chạy legacy(). Ảnh nhạy cảm (422) hoặc ảnh không khớp thì DỪNG.
 */
(function () {
    'use strict';
    if (window.MnhaDirectImage) return;

    function fatal(msg, status, code) { var e = new Error(msg); e.fatal = true; e.status = status; e.code = code; return e; }
    function soft(msg, status, code) { var e = new Error(msg); e.fatal = false; e.status = status; e.code = code; return e; }

    // Lỗi từ máy chủ của mình: 4xx (trừ 400 BAD_TICKET/404/405) và 422 → dừng; còn lại → luồng cũ
    function serverError(res, data, fallbackMsg) {
        var msg = (data && data.message) || fallbackMsg + ' (HTTP ' + res.status + ')';
        var code = data && data.code;
        var stop = res.status === 422 || res.status === 413 || res.status === 429 || res.status === 401 ||
            (res.status === 400 && code !== 'BAD_TICKET' && code !== 'NOT_UPLOADED');
        if (code === 'SENSITIVE_IMAGE' || code === 'IMAGE_MISMATCH') stop = true;
        return stop ? fatal(msg, res.status, code) : soft(msg, res.status, code);
    }

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (res) {
            return res.text().then(function (txt) {
                var data = null;
                try { data = JSON.parse(txt); } catch (e) { data = null; }
                return { res: res, data: data };
            });
        }, function (e) { throw soft('Mất kết nối tới máy chủ: ' + e.message); });
    }

    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
            r.onerror = function () { reject(soft('Không đọc được file ảnh.')); };
            r.readAsDataURL(blob);
        });
    }

    function uploadToCloudinary(cloud, blob) {
        var fd = new FormData();
        Object.keys(cloud.fields).forEach(function (k) { fd.append(k, cloud.fields[k]); });
        fd.append('file', blob, 'image');
        return fetch(cloud.url, { method: 'POST', body: fd }).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (j) {
                if (!res.ok || !j || j.error) {
                    var why = (j && j.error && j.error.message) || ('HTTP ' + res.status);
                    if (/too large|maximum|exceed|megapixel/i.test(why)) throw fatal('Ảnh vượt giới hạn của Cloudinary (tối đa 10MB và 25 megapixel). Hãy chọn ảnh nhỏ hơn.', 413);
                    throw soft('Cloudinary "' + cloud.cloudName + '": ' + why);
                }
                return { cloudName: cloud.cloudName, moderation: j.moderation || [] };
            });
        }, function (e) { throw soft('Không gửi thẳng được lên Cloudinary (' + e.message + ')'); });
    }

    function putToGithub(gh, path, blob, b64) {
        var url = 'https://api.github.com/repos/' + encodeURIComponent(gh.owner) + '/' + encodeURIComponent(gh.repo) +
            '/contents/' + path.split('/').map(encodeURIComponent).join('/');
        return fetch(url, {
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + gh.token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '[Direct image] ' + path, content: b64, branch: gh.branch })
        }).then(function (res) {
            if (!res.ok) {
                return res.json().catch(function () { return null; }).then(function (j) {
                    throw soft('GitHub từ chối (HTTP ' + res.status + (j && j.message ? ': ' + j.message : '') + ')');
                });
            }
        }, function (e) { throw soft('Không gửi thẳng được lên GitHub (' + e.message + ')'); });
    }

    function direct(o, blob, say) {
        var base = o.base;
        say('⏳ Chuẩn bị tải ảnh thẳng lên Cloudinary…');
        return postJson(base + '/direct-init', { names: o.names.join(','), mime: blob.type, size: blob.size }).then(function (r) {
            if (!r.res.ok || !r.data || !r.data.success) throw serverError(r.res, r.data, 'Máy chủ chưa cấp được phiên up thẳng');
            var init = r.data, reported = [];
            return init.clouds.reduce(function (p, cloud) {
                return p.then(function () {
                    say('⏳ Gửi ảnh thẳng lên Cloudinary (' + cloud.cloudName + ') để kiểm duyệt…');
                    return uploadToCloudinary(cloud, blob).then(function (x) { reported.push(x); });
                });
            }, Promise.resolve()).then(function () {
                say('⏳ Máy chủ đang xác nhận kết quả kiểm duyệt…');
                return postJson(base + '/direct-verify', { ticket: init.ticket, reported: reported });
            });
        }).then(function (r) {
            if (!r.res.ok || !r.data || !r.data.success) throw serverError(r.res, r.data, 'Không xác nhận được kiểm duyệt');
            var v = r.data;
            say('⏳ Ảnh hợp lệ — lưu thẳng lên GitHub…');
            return blobToBase64(blob).then(function (b64) { return putToGithub(v.gh, v.path, blob, b64); }).then(function () {
                return postJson(base + '/direct-done', { ticket: v.ticket, moderatedBy: v.moderatedBy });
            });
        }).then(function (r) {
            if (!r.res.ok || !r.data || !r.data.success) throw serverError(r.res, r.data, 'Máy chủ chưa xác nhận được ảnh đã lưu');
            return r.data;
        });
    }

    function run(o) {
        var say = o.status || function () { };
        var names = (o.names || []).filter(Boolean);
        var prep = o.compress && o.maxBytes && o.file.size > o.maxBytes ? o.compress(o.file, o.maxBytes) : Promise.resolve(o.file);
        return prep.then(function (blob) {
            if (!blob.type) blob = new Blob([blob], { type: o.file.type });
            return direct({ base: o.base, names: names }, blob, say).catch(function (e) {
                if (e && e.fatal) throw e;
                if (!o.legacy) throw e;
                if (window.console) console.warn('[directImage] không up thẳng được → dùng luồng cũ:', e && e.message);
                say('⚠ Không up thẳng được (' + ((e && e.message) || 'lỗi không rõ') + ') — đang up bằng luồng cũ qua máy chủ…');
                return o.legacy();
            });
        });
    }

    window.MnhaDirectImage = { run: run };
})();
