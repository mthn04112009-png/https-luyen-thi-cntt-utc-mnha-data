/* theme.js — chuyển giao diện Sáng / Tối cho toàn site. MẶC ĐỊNH: SÁNG.
   - Nạp ở <head> (đồng bộ) nên đặt data-theme trên <html> trước khi vẽ trang → không bị nháy màu.
   - Lựa chọn lưu ở localStorage('theme'). Nút 🌙/☀️ có sẵn trên thanh menu (layout.pug) hoặc tự chèn nổi ở góc phải-dưới nếu trang không có [data-theme-toggle].
   - CSS tương ứng: /css/theme.css */
(function () {
    var KEY = 'theme';
    function get() { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
    function apply(t) {
        document.documentElement.setAttribute('data-theme', t);
        var btns = document.querySelectorAll('[data-theme-toggle]');
        for (var i = 0; i < btns.length; i++) paint(btns[i], t);
    }
    function paint(b, t) {
        var dark = t === 'dark';
        b.textContent = dark ? '☀️' : '🌙';
        b.title = dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
        b.setAttribute('aria-label', b.title);
    }
    function toggle() {
        var next = get() === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY, next); } catch (e) { /* bỏ qua */ }
        apply(next);
    }
    window.__setTheme = function (t) { try { localStorage.setItem(KEY, t === 'dark' ? 'dark' : 'light'); } catch (e) { /* bỏ qua */ } apply(get()); };
    apply(get());                                           // chạy ngay trong <head>
    document.addEventListener('DOMContentLoaded', function () {
        if (!document.getElementById('theme-dark-layer')) {        // lớp phủ đảo màu (xem css/theme.css)
            var layer = document.createElement('div'); layer.id = 'theme-dark-layer'; layer.setAttribute('aria-hidden', 'true');
            document.body.appendChild(layer);
        }
        var have = document.querySelectorAll('[data-theme-toggle]');
        if (!have.length) {
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'theme-fab'; b.setAttribute('data-theme-toggle', '');
            document.body.appendChild(b);
        }
        var all = document.querySelectorAll('[data-theme-toggle]');
        for (var i = 0; i < all.length; i++) { all[i].addEventListener('click', toggle); }
        apply(get());
    });
    window.addEventListener('storage', function (e) { if (e.key === KEY) apply(get()); });   // đồng bộ giữa các tab
})();
