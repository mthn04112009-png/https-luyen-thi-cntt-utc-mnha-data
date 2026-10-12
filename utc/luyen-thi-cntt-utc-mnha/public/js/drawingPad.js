/* ============================================================
 * drawingPad.js — Bảng vẽ tay kiểu "JS Paint" cho bài tự luận
 * ------------------------------------------------------------
 *  Dùng:
 *    const pad = DrawingPad.create(document.getElementById("drawingPad"), { onChange })
 *    pad.hasContent()            → có nét vẽ thật chưa (đồng bộ)
 *    await pad.exportImage()     → null (trống) | { dataUrl, mime, bytes, width, height }
 *    pad.importBitmap(canvas)    → đưa ảnh (nét đen nền trong suốt) vào tờ giấy; true nếu được
 *    pad.isDisabled()            → đang khoá?
 *    pad.setDisabled(true|false) → khoá/mở vẽ (vẫn phóng to/cuộn xem được)
 *    pad.clear()                 → xoá hết
 *
 *  Tính năng: bút, tẩy, đường thẳng, chữ nhật, elip, tay kéo (pan),
 *  chọn màu + độ dày, hoàn tác/làm lại, PHÓNG TO / THU NHỎ (nút, Ctrl+lăn chuột),
 *  nút CUỘN LÊN / XUỐNG / TRÁI / PHẢI để vẽ tiếp ở vùng khác, toàn màn hình.
 *
 *  Lưu nét vẽ dạng vector (danh sách nét) nên hoàn tác nhẹ, không tốn RAM
 *  như chụp lại cả ảnh. Ảnh xuất ra được cắt gọn vùng có nét + nén ≤ ~800KB.
 * ============================================================ */
(function (global) {
    "use strict";

    var LOGICAL_W = 1200;   // kích thước "tờ giấy" (px logic)
    var LOGICAL_H = 1800;
    var MIN_ZOOM = 0.25;
    var MAX_ZOOM = 4;
    var ZOOM_STEP = 1.25;
    var PAN_STEP = 160;     // px màn hình mỗi lần bấm mũi tên
    var EXPORT_MAX_SIDE = 1600;
    var EXPORT_MAX_BYTES = 800 * 1024; // GitHub Contents API chỉ đọc lại file ≤ 1MB

    var COLORS = [
        "#000000", "#4b5563", "#dc2626", "#ea580c", "#ca8a04", "#16a34a",
        "#0891b2", "#2563eb", "#7c3aed", "#db2777", "#92400e", "#ffffff"
    ];

    var TOOLS = [
        { id: "pen", icon: "✏️", label: "Bút" },
        { id: "eraser", icon: "🧽", label: "Tẩy" },
        { id: "line", icon: "／", label: "Đường thẳng" },
        { id: "rect", icon: "▭", label: "Hình chữ nhật" },
        { id: "ellipse", icon: "◯", label: "Hình elip" },
        { id: "hand", icon: "✋", label: "Kéo di chuyển" }
    ];

    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }

    function btn(cls, html, title) {
        var b = el("button", cls, html);
        b.type = "button";
        if (title) { b.title = title; b.setAttribute("aria-label", title); }
        return b;
    }

    function create(root, options) {
        options = options || {};
        var onChange = typeof options.onChange === "function" ? options.onChange : function () {};

        // ---------- trạng thái ----------
        var items = [];          // các nét đã hoàn tất
        var redoStack = [];
        var current = null;      // nét đang vẽ
        var tool = "pen";
        var color = "#000000";
        var size = 4;
        var zoom = 1;
        var disabled = false;
        var panning = null;      // { x, y, left, top } khi kéo bằng tay

        // ---------- DOM ----------
        root.classList.add("dp-root");
        root.innerHTML = "";
        root.setAttribute("tabindex", "0");

        var toolbar = el("div", "dp-toolbar");

        // Nhóm công cụ
        var gTools = el("div", "dp-group");
        var toolBtns = {};
        TOOLS.forEach(function (t) {
            var b = btn("dp-btn dp-tool", t.icon, t.label);
            b.addEventListener("click", function () { setTool(t.id); });
            toolBtns[t.id] = b;
            gTools.appendChild(b);
        });
        toolbar.appendChild(gTools);

        // Nhóm màu
        var gColors = el("div", "dp-group dp-colors");
        var colorBtns = [];
        COLORS.forEach(function (c) {
            var b = btn("dp-swatch", "", "Màu " + c);
            b.style.background = c;
            b.addEventListener("click", function () { setColor(c); });
            colorBtns.push({ c: c, b: b });
            gColors.appendChild(b);
        });
        var colorInput = el("input", "dp-color-input");
        colorInput.type = "color";
        colorInput.value = color;
        colorInput.title = "Chọn màu khác";
        colorInput.addEventListener("input", function () { setColor(colorInput.value); });
        gColors.appendChild(colorInput);
        toolbar.appendChild(gColors);

        // Độ dày
        var gSize = el("div", "dp-group");
        var sizeLabel = el("span", "dp-size-label", "Nét: 4");
        var sizeInput = el("input", "dp-size");
        sizeInput.type = "range";
        sizeInput.min = "1";
        sizeInput.max = "40";
        sizeInput.value = String(size);
        sizeInput.title = "Độ dày nét";
        sizeInput.addEventListener("input", function () {
            size = Number(sizeInput.value) || 4;
            sizeLabel.textContent = "Nét: " + size;
        });
        gSize.appendChild(sizeLabel);
        gSize.appendChild(sizeInput);
        toolbar.appendChild(gSize);

        // Hoàn tác / làm lại / xoá
        var gHist = el("div", "dp-group");
        var undoBtn = btn("dp-btn", "↶", "Hoàn tác (Ctrl+Z)");
        var redoBtn = btn("dp-btn", "↷", "Làm lại (Ctrl+Y)");
        var clearBtn = btn("dp-btn dp-danger", "🗑", "Xoá toàn bộ bản vẽ");
        undoBtn.addEventListener("click", undo);
        redoBtn.addEventListener("click", redo);
        clearBtn.addEventListener("click", function () {
            if (disabled || !items.length) return;
            if (confirm("Xoá toàn bộ bản vẽ?")) clear();
        });
        gHist.appendChild(undoBtn);
        gHist.appendChild(redoBtn);
        gHist.appendChild(clearBtn);
        toolbar.appendChild(gHist);

        // Phóng to / thu nhỏ
        var gZoom = el("div", "dp-group");
        var zoomOutBtn = btn("dp-btn", "🔍−", "Thu nhỏ");
        var zoomLabel = el("span", "dp-zoom-label", "100%");
        var zoomInBtn = btn("dp-btn", "🔍+", "Phóng to");
        var fitBtn = btn("dp-btn", "⤢", "Vừa chiều ngang");
        zoomOutBtn.addEventListener("click", function () { zoomBy(1 / ZOOM_STEP); });
        zoomInBtn.addEventListener("click", function () { zoomBy(ZOOM_STEP); });
        fitBtn.addEventListener("click", fitWidth);
        gZoom.appendChild(zoomOutBtn);
        gZoom.appendChild(zoomLabel);
        gZoom.appendChild(zoomInBtn);
        gZoom.appendChild(fitBtn);
        toolbar.appendChild(gZoom);

        // Cuộn lên / xuống / trái / phải
        var gPan = el("div", "dp-group");
        var upBtn = btn("dp-btn", "▲", "Cuộn lên");
        var downBtn = btn("dp-btn", "▼", "Cuộn xuống");
        var leftBtn = btn("dp-btn", "◀", "Cuộn sang trái");
        var rightBtn = btn("dp-btn", "▶", "Cuộn sang phải");
        upBtn.addEventListener("click", function () { panBy(0, -PAN_STEP); });
        downBtn.addEventListener("click", function () { panBy(0, PAN_STEP); });
        leftBtn.addEventListener("click", function () { panBy(-PAN_STEP, 0); });
        rightBtn.addEventListener("click", function () { panBy(PAN_STEP, 0); });
        gPan.appendChild(upBtn);
        gPan.appendChild(downBtn);
        gPan.appendChild(leftBtn);
        gPan.appendChild(rightBtn);
        toolbar.appendChild(gPan);

        // Toàn màn hình
        var fullBtn = btn("dp-btn", "⛶", "Toàn màn hình");
        fullBtn.addEventListener("click", toggleFull);
        toolbar.appendChild(fullBtn);

        // Khung vẽ
        var viewport = el("div", "dp-viewport");
        var stage = el("div", "dp-stage");
        var canvas = el("canvas", "dp-canvas");
        canvas.width = LOGICAL_W;
        canvas.height = LOGICAL_H;
        stage.appendChild(canvas);
        viewport.appendChild(stage);

        var overlay = el("div", "dp-overlay", "🔒 Chưa thể vẽ lúc này");
        viewport.appendChild(overlay);

        var statusBar = el("div", "dp-status");
        var statusText = el("span", "dp-status-text", "Sẵn sàng — vẽ bằng chuột, bút hoặc ngón tay.");
        var statusPos = el("span", "dp-status-pos", "");
        statusBar.appendChild(statusText);
        statusBar.appendChild(statusPos);

        root.appendChild(toolbar);
        root.appendChild(viewport);
        root.appendChild(statusBar);

        var ctx = canvas.getContext("2d", { willReadFrequently: true });

        // ---------- vẽ ----------
        function paintBackground() {
            ctx.save();
            ctx.globalCompositeOperation = "source-over";
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
            ctx.restore();
        }

        function strokeStyleFor(item) {
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.strokeStyle = item.tool === "eraser" ? "#ffffff" : item.color;
            ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = item.tool === "eraser" ? item.size * 3 : item.size;
        }

        function drawItem(item) {
            // Ảnh nhập từ ảnh chụp (đã chuyển thành nét đen nền trong suốt)
            if (item.tool === "bitmap") {
                ctx.drawImage(item.canvas, item.x, item.y, item.w, item.h);
                return;
            }
            strokeStyleFor(item);
            if (item.tool === "pen" || item.tool === "eraser") {
                var p = item.pts;
                if (p.length === 1) {
                    ctx.beginPath();
                    ctx.arc(p[0].x, p[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
                    ctx.fill();
                    return;
                }
                ctx.beginPath();
                ctx.moveTo(p[0].x, p[0].y);
                for (var i = 1; i < p.length - 1; i++) {
                    var mx = (p[i].x + p[i + 1].x) / 2;
                    var my = (p[i].y + p[i + 1].y) / 2;
                    ctx.quadraticCurveTo(p[i].x, p[i].y, mx, my);
                }
                var last = p[p.length - 1];
                ctx.lineTo(last.x, last.y);
                ctx.stroke();
            } else if (item.tool === "line") {
                ctx.beginPath();
                ctx.moveTo(item.a.x, item.a.y);
                ctx.lineTo(item.b.x, item.b.y);
                ctx.stroke();
            } else if (item.tool === "rect") {
                ctx.strokeRect(
                    Math.min(item.a.x, item.b.x), Math.min(item.a.y, item.b.y),
                    Math.abs(item.b.x - item.a.x), Math.abs(item.b.y - item.a.y)
                );
            } else if (item.tool === "ellipse") {
                var cx = (item.a.x + item.b.x) / 2;
                var cy = (item.a.y + item.b.y) / 2;
                var rx = Math.abs(item.b.x - item.a.x) / 2;
                var ry = Math.abs(item.b.y - item.a.y) / 2;
                ctx.beginPath();
                ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        function redraw() {
            paintBackground();
            for (var i = 0; i < items.length; i++) drawItem(items[i]);
            if (current) drawItem(current);
        }

        // Vẽ thêm từng đoạn cho bút/tẩy (không vẽ lại cả bản vẽ mỗi lần di chuyển)
        function drawLastSegment(item) {
            var p = item.pts;
            if (p.length < 2) { drawItem(item); return; }
            strokeStyleFor(item);
            var a = p[p.length - 2], b = p[p.length - 1];
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }

        // ---------- toạ độ ----------
        function toLogical(ev) {
            var r = canvas.getBoundingClientRect();
            return {
                x: (ev.clientX - r.left) * (LOGICAL_W / r.width),
                y: (ev.clientY - r.top) * (LOGICAL_H / r.height)
            };
        }

        // ---------- sự kiện con trỏ ----------
        var activePointerId = null;

        canvas.addEventListener("pointerdown", function (ev) {
            if (ev.pointerType === "mouse" && ev.button !== 0) return;
            if (activePointerId !== null) return;

            // Tay kéo: chuột kéo thủ công; cảm ứng dùng cuộn gốc của trình duyệt
            if (tool === "hand") {
                if (ev.pointerType === "touch") return;
                activePointerId = ev.pointerId;
                canvas.setPointerCapture(ev.pointerId);
                panning = { x: ev.clientX, y: ev.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
                canvas.classList.add("dp-grabbing");
                ev.preventDefault();
                return;
            }

            if (disabled) return;
            activePointerId = ev.pointerId;
            canvas.setPointerCapture(ev.pointerId);
            ev.preventDefault();

            var pt = toLogical(ev);
            if (tool === "pen" || tool === "eraser") {
                current = { tool: tool, color: color, size: size, pts: [pt] };
                drawItem(current);
            } else {
                current = { tool: tool, color: color, size: size, a: pt, b: pt };
            }
        });

        canvas.addEventListener("pointermove", function (ev) {
            var pt = toLogical(ev);
            statusPos.textContent = Math.round(pt.x) + ", " + Math.round(pt.y);

            if (ev.pointerId !== activePointerId) return;

            if (panning) {
                viewport.scrollLeft = panning.left - (ev.clientX - panning.x);
                viewport.scrollTop = panning.top - (ev.clientY - panning.y);
                return;
            }
            if (!current) return;
            ev.preventDefault();

            if (current.tool === "pen" || current.tool === "eraser") {
                // gộp các điểm sát nhau cho nhẹ
                var last = current.pts[current.pts.length - 1];
                if (Math.abs(pt.x - last.x) + Math.abs(pt.y - last.y) < 0.8) return;
                current.pts.push(pt);
                drawLastSegment(current);
            } else {
                current.b = pt;
                redraw();
            }
        });

        function endPointer(ev) {
            if (ev.pointerId !== activePointerId) return;
            activePointerId = null;
            try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }

            if (panning) {
                panning = null;
                canvas.classList.remove("dp-grabbing");
                return;
            }
            if (!current) return;

            var done = current;
            current = null;

            // Hình có kích thước 0 (chạm 1 lần) → bỏ qua
            if ((done.tool === "line" || done.tool === "rect" || done.tool === "ellipse") &&
                Math.abs(done.b.x - done.a.x) + Math.abs(done.b.y - done.a.y) < 2) {
                redraw();
                return;
            }

            items.push(done);
            redoStack = [];
            // Nét bút/tẩy đã được vẽ trực tiếp; hình thì vẽ lại cho chắc
            if (done.tool !== "pen" && done.tool !== "eraser") redraw();
            changed();
        }
        canvas.addEventListener("pointerup", endPointer);
        canvas.addEventListener("pointercancel", endPointer);

        canvas.addEventListener("pointerleave", function () { statusPos.textContent = ""; });

        // Ctrl + lăn chuột = phóng to/thu nhỏ quanh vị trí con trỏ
        viewport.addEventListener("wheel", function (ev) {
            if (!(ev.ctrlKey || ev.metaKey)) return;
            ev.preventDefault();
            zoomBy(ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ev.clientX, ev.clientY);
        }, { passive: false });

        // Phím tắt khi đang chọn bảng vẽ
        root.addEventListener("keydown", function (ev) {
            var k = ev.key.toLowerCase();
            if ((ev.ctrlKey || ev.metaKey) && k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); }
            else if ((ev.ctrlKey || ev.metaKey) && (k === "y" || (k === "z" && ev.shiftKey))) { ev.preventDefault(); redo(); }
            else if (ev.key === "Escape" && root.classList.contains("dp-fullscreen")) { toggleFull(); }
        });

        // ---------- công cụ / lịch sử ----------
        function setTool(id) {
            tool = id;
            Object.keys(toolBtns).forEach(function (k) {
                toolBtns[k].classList.toggle("active", k === id);
            });
            canvas.classList.toggle("dp-hand", id === "hand");
            canvas.classList.toggle("dp-eraser", id === "eraser");
        }

        function setColor(c) {
            color = c;
            colorInput.value = c;
            colorBtns.forEach(function (x) { x.b.classList.toggle("active", x.c === c); });
            if (tool === "eraser" || tool === "hand") setTool("pen");
        }

        function undo() {
            if (disabled || !items.length) return;
            redoStack.push(items.pop());
            redraw();
            changed();
        }

        function redo() {
            if (disabled || !redoStack.length) return;
            items.push(redoStack.pop());
            redraw();
            changed();
        }

        function clear() {
            items = [];
            redoStack = [];
            current = null;
            redraw();
            changed();
        }

        function hasContent() {
            for (var i = 0; i < items.length; i++) if (items[i].tool !== "eraser") return true;
            return false;
        }

        function changed() {
            undoBtn.disabled = disabled || !items.length;
            redoBtn.disabled = disabled || !redoStack.length;
            clearBtn.disabled = disabled || !items.length;
            statusText.textContent = hasContent()
                ? "Đã có " + items.length + " nét vẽ — sẽ được AI đọc & chấm cùng bài viết."
                : "Chưa có nét vẽ — bài nộp sẽ chỉ chấm phần nhập chữ.";
            onChange({ hasContent: hasContent(), strokes: items.length });
        }

        // ---------- phóng to / cuộn ----------
        function applyZoom() {
            var w = Math.round(LOGICAL_W * zoom);
            var h = Math.round(LOGICAL_H * zoom);
            stage.style.width = w + "px";
            stage.style.height = h + "px";
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";
            zoomLabel.textContent = Math.round(zoom * 100) + "%";
            zoomOutBtn.disabled = zoom <= MIN_ZOOM + 0.001;
            zoomInBtn.disabled = zoom >= MAX_ZOOM - 0.001;
        }

        // Giữ nguyên điểm đang nhìn (tâm khung hoặc vị trí con trỏ) khi đổi mức zoom
        function zoomBy(factor, clientX, clientY) {
            var next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
            if (Math.abs(next - zoom) < 0.0001) return;

            var vr = viewport.getBoundingClientRect();
            var ax = (clientX !== undefined ? clientX - vr.left : vr.width / 2);
            var ay = (clientY !== undefined ? clientY - vr.top : vr.height / 2);
            var lx = (viewport.scrollLeft + ax) / zoom;
            var ly = (viewport.scrollTop + ay) / zoom;

            zoom = next;
            applyZoom();
            viewport.scrollLeft = lx * zoom - ax;
            viewport.scrollTop = ly * zoom - ay;
        }

        function fitWidth() {
            if (!viewport.clientWidth) return; // đang ẩn (tab khác) — sẽ fit lại khi hiện ra
            var avail = viewport.clientWidth - 2;
            zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / LOGICAL_W));
            applyZoom();
            viewport.scrollLeft = 0;
        }

        function panBy(dx, dy) {
            viewport.scrollBy({ left: dx, top: dy, behavior: "smooth" });
        }

        function toggleFull() {
            var on = root.classList.toggle("dp-fullscreen");
            document.body.classList.toggle("dp-no-scroll", on);
            fullBtn.textContent = on ? "✕" : "⛶";
            fullBtn.title = on ? "Thoát toàn màn hình (Esc)" : "Toàn màn hình";
            setTimeout(function () { if (on) fitWidth(); }, 30);
        }

        // Đưa 1 canvas (nét đen, nền trong suốt) vào tờ giấy như 1 "nét" — hoàn tác/tẩy/vẽ đè được
        function importBitmap(src) {
            if (disabled || !src || !src.width || !src.height) return false;
            var margin = 40;
            var s = Math.min(1, (LOGICAL_W - margin * 2) / src.width, (LOGICAL_H - margin * 2) / src.height);
            var item = {
                tool: "bitmap",
                canvas: src,
                x: margin,
                y: margin,
                w: Math.max(1, Math.round(src.width * s)),
                h: Math.max(1, Math.round(src.height * s))
            };
            items.push(item);
            redoStack = [];
            redraw();
            changed();
            return true;
        }

        function setDisabled(flag) {
            disabled = !!flag;
            root.classList.toggle("dp-disabled", disabled);
            overlay.style.display = disabled ? "flex" : "none";
            [gTools, gColors, gSize].forEach(function (g) {
                Array.prototype.forEach.call(g.querySelectorAll("button,input"), function (n) {
                    // Tay kéo luôn dùng được để xem lại bản vẽ
                    if (n === toolBtns.hand) return;
                    n.disabled = disabled;
                });
            });
            changed();
        }

        // ---------- xuất ảnh ----------
        function findBounds() {
            var data = ctx.getImageData(0, 0, LOGICAL_W, LOGICAL_H).data;
            var minX = LOGICAL_W, minY = LOGICAL_H, maxX = -1, maxY = -1;
            for (var y = 0; y < LOGICAL_H; y++) {
                var row = y * LOGICAL_W * 4;
                for (var x = 0; x < LOGICAL_W; x++) {
                    var i = row + x * 4;
                    // không phải trắng (có nét)
                    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 0) return null;
            return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
        }

        function canvasToBlob(c, type, quality) {
            return new Promise(function (resolve) { c.toBlob(resolve, type, quality); });
        }

        function blobToDataUrl(blob) {
            return new Promise(function (resolve, reject) {
                var fr = new FileReader();
                fr.onload = function () { resolve(fr.result); };
                fr.onerror = function () { reject(new Error("Không đọc được ảnh vẽ.")); };
                fr.readAsDataURL(blob);
            });
        }

        // Cắt vùng có nét + thu nhỏ để ≤ EXPORT_MAX_SIDE và ≤ EXPORT_MAX_BYTES
        async function exportImage() {
            if (!hasContent()) return null;

            var b = findBounds();
            if (!b) return null; // chỉ có nét tẩy → coi như trống

            var pad = 24;
            var sx = Math.max(0, b.x - pad), sy = Math.max(0, b.y - pad);
            var sw = Math.min(LOGICAL_W - sx, b.w + pad * 2);
            var sh = Math.min(LOGICAL_H - sy, b.h + pad * 2);

            var scale = Math.min(1, EXPORT_MAX_SIDE / Math.max(sw, sh));
            var out = document.createElement("canvas");
            var octx = out.getContext("2d");

            async function render(sc) {
                out.width = Math.max(1, Math.round(sw * sc));
                out.height = Math.max(1, Math.round(sh * sc));
                octx.fillStyle = "#ffffff";
                octx.fillRect(0, 0, out.width, out.height);
                octx.imageSmoothingQuality = "high";
                octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
            }

            // 1) PNG, thu nhỏ dần tới khi đủ nhẹ
            var sc = scale;
            for (var i = 0; i < 6; i++) {
                await render(sc);
                var png = await canvasToBlob(out, "image/png");
                if (png && png.size <= EXPORT_MAX_BYTES) {
                    return {
                        dataUrl: await blobToDataUrl(png), mime: "image/png",
                        bytes: png.size, width: out.width, height: out.height
                    };
                }
                if (sc <= 0.5) break;
                sc *= 0.82;
            }

            // 2) JPEG (nền trắng nên vẫn rõ nét) — giảm chất lượng/kích thước dần
            var q = 0.9;
            for (var j = 0; j < 8; j++) {
                await render(sc);
                var jpg = await canvasToBlob(out, "image/jpeg", q);
                if (jpg && jpg.size <= EXPORT_MAX_BYTES) {
                    return {
                        dataUrl: await blobToDataUrl(jpg), mime: "image/jpeg",
                        bytes: jpg.size, width: out.width, height: out.height
                    };
                }
                if (q > 0.6) q -= 0.1; else sc *= 0.85;
            }
            throw new Error("Bản vẽ quá phức tạp để nén ≤ 800KB. Hãy xoá bớt hoặc vẽ gọn hơn.");
        }

        // ---------- khởi tạo ----------
        paintBackground();
        setTool("pen");
        setColor("#000000");
        applyZoom();
        setDisabled(false);
        // Zoom ban đầu: vừa chiều ngang khung (đợi layout xong mới đo được)
        setTimeout(fitWidth, 0);

        return {
            hasContent: hasContent,
            exportImage: exportImage,
            importBitmap: importBitmap,
            isDisabled: function () { return disabled; },
            setDisabled: setDisabled,
            clear: clear,
            fitWidth: fitWidth,
            zoomIn: function () { zoomBy(ZOOM_STEP); },
            zoomOut: function () { zoomBy(1 / ZOOM_STEP); }
        };
    }

    global.DrawingPad = { create: create };
})(window);
