/* ============================================================
 * flashcardForm.js — Trang TẠO / SỬA flashcard (/flashcards/dashboard/new, /:id/edit)
 *  - Đổi hình thức học (ngoại ngữ ↔ lý thuyết): ẩn/hiện chọn ngôn ngữ + đổi prompt + định dạng gợi ý
 *  - Xem trước & kiểm tra nội dung (gọi POST /flashcards/dashboard/parse)
 *  - Thêm ảnh: giống bài trắc nghiệm — chọn tài khoản Cloudinary kiểm duyệt → lưu GitHub → tự chèn link ảnh
 *  - Lưu: POST /flashcards/dashboard  (tạo) | /flashcards/dashboard/:id  (sửa)
 * ============================================================ */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var S = JSON.parse($('fcState').textContent);

    var els = {
        subject: $('fcSubject'), title: $('fcTitle'), desc: $('fcDesc'), lang: $('fcLang'), langBox: $('fcLangBox'),
        pub: $('fcPub'), content: $('fcContent'), msg: $('fcMsg'), save: $('fcSave'),
        summary: $('fcSummary'), errors: $('fcErrors'), hints: $('fcHints'), cards: $('fcCards'),
        prompt: $('fcPrompt'), copy: $('fcCopy'),
        cloud: $('fcCloud'), upBtn: $('fcUpBtn'), file: $('fcFile'), upStatus: $('fcUpStatus'),
        fmtLang: $('fcFmtLang'), fmtTheory: $('fcFmtTheory')
    };

    var mode = S.mode === 'theory' ? 'theory' : 'language';
    var dirty = false;

    // ------------------------------------------------------------
    // Khởi tạo giá trị
    // ------------------------------------------------------------
    els.subject.value = S.subjectId || '';
    els.title.value = S.title || '';
    els.desc.value = S.description || '';
    els.lang.value = S.language || 'en-US';
    els.pub.checked = S.isPublished !== false;
    els.content.value = S.content || '';

    function showMsg(kind, text) {
        els.msg.className = 'mb-4 p-4 rounded-xl text-sm ' + (kind === 'ok'
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-red-50 border border-red-200 text-red-800');
        els.msg.textContent = text;
        els.msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function hideMsg() { els.msg.className = 'hidden'; }

    // ------------------------------------------------------------
    // Hình thức học
    // ------------------------------------------------------------
    function applyMode() {
        document.querySelectorAll('.fc-mode').forEach(function (lb) {
            var on = lb.getAttribute('data-mode') === mode;
            lb.classList.toggle('border-indigo-500', on);
            lb.classList.toggle('bg-indigo-50', on);
            lb.classList.toggle('border-gray-200', !on);
            lb.querySelector('input').checked = on;
        });
        els.langBox.style.display = mode === 'language' ? '' : 'none';
        els.fmtLang.classList.toggle('hidden', mode !== 'language');
        els.fmtTheory.classList.toggle('hidden', mode !== 'theory');
        updatePrompt();
        schedulePreview();
    }

    function updatePrompt() {
        var text = mode === 'theory' ? S.prompts.theory : S.prompts.language;
        if (mode === 'language') {
            var opt = els.lang.options[els.lang.selectedIndex];
            var name = (opt ? opt.textContent.split(' — ')[0] : 'Tiếng Anh').replace(/^Tiếng /, '');
            text = text.replace(/\{LANG\}/g, name);
        }
        els.prompt.value = text;
    }

    document.querySelectorAll('.fc-mode').forEach(function (lb) {
        lb.addEventListener('click', function (e) {
            e.preventDefault();
            var m = lb.getAttribute('data-mode');
            if (m === mode) return;
            if (m === 'theory' && /^\s*\+\+\)/m.test(els.content.value)) {
                if (!confirm('Chế độ "Học lý thuyết" không dùng dòng ++) (phiên âm). Các dòng ++) sẽ báo lỗi cho tới khi bạn xoá. Vẫn chuyển?')) return;
            }
            mode = m;
            dirty = true;
            applyMode();
        });
    });
    els.lang.addEventListener('change', function () { dirty = true; updatePrompt(); });

    // ------------------------------------------------------------
    // Sao chép prompt
    // ------------------------------------------------------------
    els.copy.addEventListener('click', function () {
        var done = function () {
            var old = els.copy.innerHTML;
            els.copy.textContent = 'Đã sao chép ✓';
            setTimeout(function () { els.copy.innerHTML = old; if (window.lucide) window.lucide.createIcons(); }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(els.prompt.value).then(done, function () { els.prompt.select(); document.execCommand('copy'); done(); });
        } else {
            els.prompt.select();
            document.execCommand('copy');
            done();
        }
    });

    // ------------------------------------------------------------
    // Xem trước / kiểm tra (server là nơi duy nhất hiểu định dạng)
    // ------------------------------------------------------------
    var previewTimer = null;
    var previewSeq = 0;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }
    function brk(s) { return String(s == null ? '' : s).replace(/(\\)?\\n(?![A-Za-z])/g, function (m, pre) { return pre ? m : '\n'; }); }

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(runPreview, 350);
    }

    function runPreview() {
        var seq = ++previewSeq;
        var text = els.content.value;
        if (!text.trim()) {
            els.summary.textContent = 'Chưa có nội dung.';
            els.summary.className = 'text-sm font-medium text-gray-500';
            els.errors.innerHTML = '';
            els.cards.innerHTML = '';
            els.hints.classList.add('hidden');
            return;
        }
        (window.MnhaData ? window.MnhaData.fetch : fetch)('/flashcards/dashboard/parse', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ mode: mode, content: text })
        }).then(function (r) { return r.json(); }).then(function (d) {
            if (seq !== previewSeq || !d || !d.success) return;
            renderPreview(d);
        }).catch(function () { /* mạng lỗi: bỏ qua, lần gõ sau sẽ thử lại */ });
    }

    function renderPreview(d) {
        var bad = d.errors && d.errors.length;
        els.summary.textContent = (d.total || 0) + ' thẻ hợp lệ' + (bad ? ' · ' + d.errors.length + ' lỗi cần sửa' : ' ✓');
        els.summary.className = 'text-sm font-medium ' + (bad ? 'text-red-600' : 'text-green-700');
        els.errors.innerHTML = (d.errors || []).slice(0, 12).map(function (e) {
            return '<li>' + (e.line ? '<b>Dòng ' + e.line + ':</b> ' : '') + esc(e.message) + '</li>';
        }).join('') + ((d.errors || []).length > 12 ? '<li>… và ' + (d.errors.length - 12) + ' lỗi khác</li>' : '');

        if (d.imageHints && d.imageHints.length) {
            els.hints.classList.remove('hidden');
            els.hints.textContent = '🖼 AI gợi ý các thẻ nên có ảnh: ' + d.imageHints.join(', ') + ' (đặt con trỏ vào thẻ rồi bấm "Thêm ảnh").';
        } else {
            els.hints.classList.add('hidden');
        }

        els.cards.innerHTML = (d.cards || []).slice(0, 6).map(function (c, i) {
            return '<div class="rounded-xl border border-gray-200 p-3 bg-white">' +
                '<div class="text-xs text-gray-400 mb-1">Thẻ ' + (i + 1) + '</div>' +
                (c.image ? '<img src="' + esc(c.image) + '" alt="" class="max-h-24 rounded-lg mb-2" referrerpolicy="no-referrer">' : '') +
                '<div class="font-semibold text-gray-900 whitespace-pre-line">' + esc(brk(c.front)) + '</div>' +
                (c.ipa ? '<div class="text-sm text-rose-500">/' + esc(c.ipa) + '/</div>' : '') +
                '<div class="text-sm text-gray-600 mt-1 whitespace-pre-line">' + esc(brk(c.back)) + '</div></div>';
        }).join('') + (d.total > 6 ? '<div class="text-sm text-gray-500 self-center">… và ' + (d.total - 6) + ' thẻ nữa</div>' : '');

        if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
            try { window.MathJax.typesetClear([els.cards]); window.MathJax.typesetPromise([els.cards]).catch(function () {}); } catch (e) { /* bỏ qua */ }
        }
    }

    els.content.addEventListener('input', function () { dirty = true; schedulePreview(); });
    [els.title, els.desc, els.subject].forEach(function (el) { el.addEventListener('input', function () { dirty = true; }); });

    // ------------------------------------------------------------
    // Thêm ảnh (giống bài trắc nghiệm)
    // ------------------------------------------------------------
    var upCfg = { loaded: false, enabled: false, accounts: [], maxBytes: 10 * 1024 * 1024, uploadMaxBytes: 3 * 1024 * 1024 };

    function upStatus(kind, text) {
        els.upStatus.className = 'text-xs mb-2 ' + (kind === 'err' ? 'text-red-600' : kind === 'ok' ? 'text-green-700' : 'text-gray-600');
        els.upStatus.textContent = text;
    }

    function refreshCloud() {
        var accounts = upCfg.accounts || [];
        els.cloud.innerHTML = accounts.length
            ? accounts.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('')
            : '<option value="">(chưa có tài khoản)</option>';
        els.cloud.disabled = !accounts.length;
        els.upBtn.disabled = !upCfg.enabled;
        els.upBtn.title = upCfg.enabled ? '' : (accounts.length ? 'GitHub chưa cấu hình nên chưa lưu được ảnh' : 'Chưa có tài khoản Cloudinary — thêm ở Quản trị → API Key → Cloudinary');
    }

    (window.MnhaData ? window.MnhaData.fetch : fetch)('/admin/quiz/upload-image/config', { cache: 'no-store', headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (d && d.success) upCfg = { loaded: true, enabled: !!d.enabled, accounts: d.accounts || [], maxBytes: d.maxBytes || upCfg.maxBytes, uploadMaxBytes: d.uploadMaxBytes || d.maxBytes || upCfg.uploadMaxBytes };
            refreshCloud();
        })
        .catch(function () { refreshCloud(); });

    // Nén ảnh về ≤ limit byte (Vercel cắt request > 4.5MB); ảnh nhỏ giữ nguyên
    function fileToBlobUnder(file, limit) {
        return new Promise(function (resolve, reject) {
            if (file.size <= limit) { resolve(file); return; }
            if (file.type === 'image/gif') { reject(new Error('GIF nặng ' + (file.size / 1048576).toFixed(1) + 'MB, tối đa ' + (limit / 1048576).toFixed(1) + 'MB. Hãy dùng PNG/JPEG.')); return; }
            var url = URL.createObjectURL(file), img = new Image();
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Trình duyệt không đọc được ảnh để nén.')); };
            img.onload = function () {
                URL.revokeObjectURL(url);
                var scales = [1, 0.85, 0.7, 0.55, 0.4, 0.3], i = 0;
                var base = Math.min(1, 2400 / Math.max(img.width, img.height));
                (function attempt() {
                    var sc = base * scales[i], cv = document.createElement('canvas');
                    cv.width = Math.max(1, Math.round(img.width * sc));
                    cv.height = Math.max(1, Math.round(img.height * sc));
                    var ctx = cv.getContext('2d');
                    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
                    ctx.drawImage(img, 0, 0, cv.width, cv.height);
                    cv.toBlob(function (blob) {
                        if (blob && blob.size <= limit) { resolve(blob); return; }
                        if (++i >= scales.length) { reject(new Error('Không nén được ảnh xuống dưới ' + (limit / 1048576).toFixed(1) + 'MB.')); return; }
                        attempt();
                    }, 'image/jpeg', 0.88);
                })();
            };
            img.src = url;
        });
    }

    function blobToBase64(blob) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
            r.onerror = function () { reject(new Error('Không đọc được file ảnh.')); };
            r.readAsDataURL(blob);
        });
    }

    // Chèn link ảnh ngay dưới phần "+)" của thẻ đang đặt con trỏ (thay link ảnh cũ nếu có)
    function insertImageLine(url) {
        var ta = els.content;
        var text = ta.value;
        var lines = text.split('\n');
        var pos = ta.selectionStart || 0;
        var lineIdx = text.slice(0, pos).split('\n').length - 1;
        var isFront = function (l) { return /^\s*\+\)/.test(l); };
        var isMarker = function (l) { return /^\s*(\+\+\)|=>|\+\))/.test(l); };

        var start = lineIdx;
        while (start >= 0 && !isFront(lines[start])) start--;
        if (start < 0) start = lines.findIndex(isFront);
        if (start < 0) return false;

        var end = start + 1;
        while (end < lines.length && !isMarker(lines[end])) end++;
        // bỏ link ảnh cũ trong phần +) của thẻ
        var kept = lines.slice(start + 1, end).filter(function (l) { return !/^\s*https?:\/\/\S+\s*$/.test(l); });
        var out = lines.slice(0, start + 1).concat(kept, [url], lines.slice(end));
        ta.value = out.join('\n');
        dirty = true;
        schedulePreview();
        return true;
    }

    els.upBtn.addEventListener('click', function () { els.file.value = ''; els.file.click(); });

    els.file.addEventListener('change', function () {
        var file = els.file.files && els.file.files[0];
        if (!file) return;
        var cloud = els.cloud.value;
        if (!cloud) { upStatus('err', '❌ Hãy chọn tài khoản Cloudinary để kiểm duyệt ảnh.'); return; }
        if (!/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(file.type)) { upStatus('err', '❌ Chỉ nhận ảnh PNG / JPEG / WEBP / GIF / BMP / AVIF.'); return; }
        if (!/^\s*\+\)/m.test(els.content.value)) { upStatus('err', '❌ Hãy nhập ít nhất một dòng "+)" rồi đặt con trỏ vào thẻ cần thêm ảnh.'); return; }

        var limit = upCfg.uploadMaxBytes || upCfg.maxBytes;
        var sentMime = file.type;
        els.upBtn.disabled = true;
        els.upStatus.classList.remove('hidden');
        upStatus('busy', '⏳ Đang chuẩn bị ảnh…');

        fileToBlobUnder(file, limit).then(function (blob) {
            sentMime = blob.type || file.type;
            return blobToBase64(blob);
        }).then(function (b64) {
            upStatus('busy', '⏳ Đang kiểm duyệt ảnh bằng ' + cloud + ' rồi lưu lên GitHub…');
            return (window.MnhaData ? window.MnhaData.fetch : fetch)('/admin/quiz/upload-image', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ mime: sentMime, data: b64, names: cloud })
            });
        }).then(function (res) {
            return res.text().then(function (txt) {
                var data = null;
                try { data = JSON.parse(txt); } catch (e) { data = null; }
                if (!res.ok || !data || !data.success) {
                    throw new Error((data && data.message) ||
                        (res.status === 413 ? 'Ảnh quá nặng so với giới hạn máy chủ (Vercel ≤ 4.5MB).' :
                            'Máy chủ trả HTTP ' + res.status + (txt ? ': ' + txt.replace(/<[^>]+>/g, ' ').trim().slice(0, 140) : '')));
                }
                return data;
            });
        }).then(function (data) {
            if (!insertImageLine(data.url)) throw new Error('Không tìm thấy dòng "+)" để chèn ảnh.');
            upStatus('ok', '✓ Đã kiểm duyệt và lưu ảnh (' + data.path + '). Link đã được chèn dưới dòng "+)" của thẻ.' + (data.warning ? ' ⚠ ' + data.warning : ''));
            els.upBtn.disabled = !upCfg.enabled;
        }).catch(function (e) {
            els.upBtn.disabled = !upCfg.enabled;
            upStatus('err', '❌ ' + (e.message || 'Không tải được ảnh.'));
        });
    });

    // ------------------------------------------------------------
    // Lưu
    // ------------------------------------------------------------
    els.save.addEventListener('click', function () {
        hideMsg();
        if (!els.subject.value) { showMsg('err', 'Vui lòng chọn môn học.'); els.subject.focus(); return; }
        if (!els.title.value.trim()) { showMsg('err', 'Vui lòng nhập tiêu đề.'); els.title.focus(); return; }
        if (!els.content.value.trim()) { showMsg('err', 'Vui lòng nhập nội dung flashcard.'); els.content.focus(); return; }

        var body = {
            subjectId: els.subject.value,
            title: els.title.value.trim(),
            description: els.desc.value.trim(),
            mode: mode,
            language: els.lang.value,
            isPublished: els.pub.checked,
            content: els.content.value,
            sha: S.sha || undefined
        };
        var url = S.id ? '/flashcards/dashboard/' + S.id : '/flashcards/dashboard';

        els.save.disabled = true;
        var old = els.save.textContent;
        els.save.textContent = 'Đang lưu…';

        fetch(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) {
            return r.text().then(function (txt) {
                var d = null;
                try { d = JSON.parse(txt); } catch (e) { d = null; }
                if (!d) d = { success: false, message: r.status === 413 ? 'Nội dung quá lớn so với giới hạn máy chủ.' : 'Máy chủ trả HTTP ' + r.status };
                return d;
            });
        }).then(function (d) {
            if (d.success) {
                dirty = false;
                window.location.href = d.redirect || '/flashcards/dashboard';
                return;
            }
            els.save.disabled = false;
            els.save.textContent = old;
            var detail = (d.errors || []).slice(0, 6).map(function (e) { return (e.line ? 'Dòng ' + e.line + ': ' : '') + e.message; }).join(' • ');
            showMsg('err', (d.message || 'Không lưu được.') + (detail ? ' ' + detail : ''));
        }).catch(function (e) {
            els.save.disabled = false;
            els.save.textContent = old;
            showMsg('err', 'Lỗi mạng: ' + e.message);
        });
    });

    window.addEventListener('beforeunload', function (e) {
        if (!dirty) return;
        e.preventDefault();
        e.returnValue = '';
    });

    applyMode();
    runPreview();
})();
