// utils/lessonOrder.js
// Sắp xếp bài học MỚI TẠO NHẤT lên đầu, không phân biệt trắc nghiệm / tự luận.
// Mốc "tạo" = timestamp nhúng trong ObjectId (không đổi khi đồng bộ GitHub).
// Bài cũ có _id suy từ đường dẫn file (timestamp vô nghĩa) → dùng createdAt.

function lessonCreatedMs(l) {
    const MIN = Date.UTC(2023, 0, 1);
    const MAX = Date.now() + 24 * 3600 * 1000;
    const hex = String((l && l._id) || '');
    if (/^[0-9a-f]{24}$/i.test(hex)) {
        const t = parseInt(hex.slice(0, 8), 16) * 1000;
        if (t >= MIN && t <= MAX) return t;
    }
    const c = l && l.createdAt ? new Date(l.createdAt).getTime() : NaN;
    return Number.isFinite(c) ? c : 0;
}

function sortNewestFirst(list) {
    return list.slice().sort((a, b) => {
        const d = lessonCreatedMs(b) - lessonCreatedMs(a);
        if (d) return d;
        return String(b._id).localeCompare(String(a._id));
    });
}

module.exports = { lessonCreatedMs, sortNewestFirst };
