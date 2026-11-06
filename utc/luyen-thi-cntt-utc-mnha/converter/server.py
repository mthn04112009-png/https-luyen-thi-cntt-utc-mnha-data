#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dịch vụ đổi PPTX/PPT → PDF (chỉ dùng thư viện chuẩn của Python + LibreOffice).

Chạy:   python converter/server.py            (mặc định http://localhost:5001)
API:    POST /convert?name=bai-giang.pptx     body = nội dung file (octet-stream) → trả về application/pdf
        GET  /health

Biến môi trường (tuỳ chọn):
  PORT=5001            cổng
  HOST=127.0.0.1       0.0.0.0 nếu chạy trong Docker / server
  CONVERTER_TOKEN=...  nếu đặt, mọi request phải gửi header  X-Converter-Token
  ALLOWED_ORIGINS=https://ten-web.vercel.app,http://localhost:3000   (mặc định *)
  MAX_MB=100           giới hạn dung lượng file nhận
  SOFFICE=...          đường dẫn soffice nếu không tự tìm được
"""
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pptx_to_pdf import convert_bytes, find_soffice  # noqa: E402

PORT = int(os.environ.get("PORT", "5001"))
HOST = os.environ.get("HOST", "127.0.0.1")
TOKEN = os.environ.get("CONVERTER_TOKEN", "")
ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
MAX_BYTES = int(float(os.environ.get("MAX_MB", "100")) * 1024 * 1024)
SOFFICE = find_soffice(None)
GATE = threading.Semaphore(2)          # tối đa 2 file đổi cùng lúc (LibreOffice rất nặng)


class Handler(BaseHTTPRequestHandler):
    server_version = "pptx2pdf/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[converter] " + (fmt % args) + "\n")

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if "*" in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Converter-Token")
        self.send_header("Access-Control-Allow-Private-Network", "true")   # web https gọi tới localhost
        self.send_header("Access-Control-Max-Age", "600")

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            ok = SOFFICE is not None
            return self._send(200 if ok else 503, (b"ok" if ok else "Chưa cài LibreOffice".encode()))
        self._send(404, b"not found")

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/convert":
            return self._send(404, b"not found")
        if TOKEN and self.headers.get("X-Converter-Token", "") != TOKEN:
            return self._send(401, "Sai token".encode())
        if SOFFICE is None:
            return self._send(503, "Máy chủ chưa cài LibreOffice".encode())
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0:
            return self._send(400, "Thiếu nội dung file".encode())
        if n > MAX_BYTES:
            return self._send(413, f"File vượt {MAX_BYTES // 1048576}MB".encode())
        name = (parse_qs(u.query).get("name") or ["file.pptx"])[0]
        data = self.rfile.read(n)
        with GATE:
            try:
                pdf = convert_bytes(SOFFICE, data, name)
            except ValueError as e:
                return self._send(400, str(e).encode())
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"[converter] lỗi: {e}\n")
                return self._send(500, ("Không đổi được: " + str(e)[:300]).encode())
        self._send(200, pdf, "application/pdf")


if __name__ == "__main__":
    if SOFFICE is None:
        print("⚠ Không tìm thấy LibreOffice (soffice) — /convert sẽ trả 503. Cài LibreOffice hoặc đặt SOFFICE=...", file=sys.stderr)
    print(f"Converter chạy ở http://{HOST}:{PORT}  (token: {'bật' if TOKEN else 'tắt'}, tối đa {MAX_BYTES // 1048576}MB)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
