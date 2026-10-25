// controllers/connect.controller.js — trang /connect của WEB CHÍNH.
//
//   • Quản lý danh sách "web kết nối" trong v-s/index.json (thêm / đổi tên / bật-tắt / xoá).
//   • Kiểm tra lần lượt cũ → mới, xem web nào còn sống và lưu trạng thái.
//   • Hiện Fast Data Transfer / Fast Origin Transfer:
//       – số ĐO của ứng dụng (usage/week-<N>/index.json), và
//       – số chính thức của Vercel do admin nhập tay (lưu cùng sổ đăng ký).
//   • Hiện .env mẫu GIỐNG HỆT nhau cho từng web (chỉ khác DATA_NODE/NODE_ID/NODE_URL/NODE_NAME).
//   • Chỉ admin MẶC ĐỊNH (role=admin, userKey=null) được dùng (routes/connect.js gắn requireDefaultAdmin).
'use strict';
const registry = require('../services/connect/registry');
const nodes = require('../services/connect/nodes');
const usage = require('../services/connect/usage');
const { envTemplate, DIFFERENT_KEYS } = require('../services/connect/envTemplate');

const flash = (req, type, message) => {
    if (req.session) req.session.connectFlash = { type, message: String(message || '') };
};
const takeFlash = (req) => {
    const f = req.session && req.session.connectFlash ? req.session.connectFlash : null;
    if (f && req.session) delete req.session.connectFlash;
    return f;
};
const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) {
        console.error('[connect]', e);
        if (req.method === 'POST') {
            flash(req, 'error', e.message || 'Có lỗi xảy ra.');
            return res.redirect('/connect');
        }
        next(e);
    }
};

const mainUrl = () => String(process.env.MAIN_URL || 'https://luyen-thi-cntt-utc-mnha.vercel.app').replace(/\/+$/, '');
const mainEnv = () => envTemplate({ id: 'luyen-thi-cntt-utc-mnha', url: mainUrl(), name: 'Web chính', dataNode: false });
const nodeEnv = (n) => envTemplate({ id: n.id, url: n.url, name: n.name, dataNode: true });

exports.index = wrap(async (req, res) => {
    // Ghi bộ đếm đang giữ (nếu có) rồi mới đọc số liệu.
    await usage.flush().catch(() => { /* đã log */ });
    const list = await registry.list();
    const useMap = await usage.snapshotAll(list.map((n) => n.id)).catch(() => ({}));
    const weekOffset = usage.clampWeek(req.query && req.query.w);
    const histMap = await usage.historyAll(list.map((n) => n.id), { week: weekOffset }).catch(() => ({}));
    const viewNodes = list.map((n) => ({
        ...registry.publicNode(n),
        usage: useMap[n.id] || null,
        hist: histMap[n.id] || null,
        env: nodeEnv(n)
    }));
    // Tổng của TUẦN đang xem, cộng tất cả web.
    const weekTotal = viewNodes.reduce((a, n) => {
        const w = n.hist ? n.hist.total : null;
        if (w) for (const k of ['in', 'out', 'originIn', 'originOut', 'req']) a[k] += Number(w[k]) || 0;
        return a;
    }, { in: 0, out: 0, originIn: 0, originOut: 0, req: 0 });
    const weekInfo = viewNodes.length && viewNodes[0].hist ? viewNodes[0].hist : (await usage.history('__none__', { week: weekOffset }).catch(() => null));
    res.render('connect/index', {
        title: 'Web kết nối', user: req.user, nodes: viewNodes, weekTotal, weekInfo,
        mainEnv: mainEnv(), diffKeys: DIFFERENT_KEYS,
        registryPath: registry.PATH(), usagePath: usage.FILE(),
        fmt: usage.formatBytes, gb: usage.bytesToGb,
        flash: takeFlash(req)
    });
});

exports.check = wrap(async (req, res) => {
    const results = await nodes.checkAll({ force: true, withStatus: true });
    if (!results.length) {
        flash(req, 'info', `Chưa có web nào trong ${registry.PATH()} — hãy thêm web dữ liệu trước.`);
    } else {
        const ok = results.filter((r) => r.ok).length;
        const off = results.filter((r) => !r.ok).map((r) => r.name || r.id);
        flash(req, ok ? (off.length ? 'info' : 'success') : 'error',
            `Đã kiểm tra ${results.length} web theo thứ tự cũ → mới: ${ok} hoạt động` +
            (off.length ? `, ${off.length} lỗi (${off.join(', ')}).` : '.'));
    }
    res.redirect('/connect');
});

exports.add = wrap(async (req, res) => {
    const b = req.body || {};
    const key = String(b.key || '').trim();
    const r = await registry.upsertNode({
        url: b.url, name: b.name, key: key || undefined, note: b.note,
        createdBy: req.user ? String(req.user._id) : 'main'
    });
    flash(req, 'success', r.created
        ? `Đã thêm web "${r.node.name}".` + (key ? ` Khoá kết nối đã được mã hoá trong ${registry.PATH()}.` : ' Web sẽ tự tạo khoá khi admin mặc định đăng nhập ở web đó.')
        : `Đã cập nhật web "${r.node.name}".`);
    res.redirect('/connect');
});

exports.rename = wrap(async (req, res) => {
    const n = await registry.renameNode(req.params.id, (req.body || {}).name, (req.body || {}).note);
    flash(req, 'success', `Đã đổi tên web thành "${n.name}".`);
    res.redirect('/connect');
});

exports.toggle = wrap(async (req, res) => {
    const on = String((req.body || {}).enabled || '') === '1';
    const n = await registry.setEnabled(req.params.id, on);
    flash(req, 'success', `Đã ${on ? 'bật' : 'tắt'} web "${n.name}".`);
    res.redirect('/connect');
});

exports.remove = wrap(async (req, res) => {
    await registry.removeNode(req.params.id);
    flash(req, 'success', 'Đã xoá web khỏi danh sách kết nối (không xoá dữ liệu trên GitHub của web đó).');
    res.redirect('/connect');
});

exports.setKey = wrap(async (req, res) => {
    const doc = await registry.load();
    const n = doc.nodes.find((x) => x && x.id === req.params.id);
    if (!n) {
        const e = new Error('Không tìm thấy web.');
        e.status = 404;
        throw e;
    }
    const key = String((req.body || {}).key || '').trim();
    if (key.length < 32) throw new Error('Khoá kết nối phải dài ít nhất 32 ký tự.');
    await registry.upsertNode({ id: n.id, url: n.url, name: n.name, key });
    flash(req, 'success', `Đã lưu khoá kết nối (mã hoá 2 chiều trong ${registry.PATH()}).`);
    res.redirect('/connect');
});

exports.vercel = wrap(async (req, res) => {
    const b = req.body || {};
    const n = await registry.setVercelUsage(req.params.id, {
        fastDataTransferGb: b.fastDataTransferGb,
        fastOriginTransferGb: b.fastOriginTransferGb,
        note: b.note
    });
    flash(req, 'success', `Đã lưu số liệu Vercel cho "${n.name}".`);
    res.redirect('/connect');
});
