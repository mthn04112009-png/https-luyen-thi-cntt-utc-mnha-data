#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Đổi PPTX/PPT → PDF bằng LibreOffice (headless) để up PDF vào mục Slide.

Cách dùng:
  python converter/pptx_to_pdf.py bai-giang.pptx            # → bai-giang.pdf cạnh file gốc
  python converter/pptx_to_pdf.py a.pptx b.ppt -o out/      # nhiều file, lưu vào thư mục out/
  python converter/pptx_to_pdf.py thu-muc-slide/ -o pdf/    # cả thư mục (quét .pptx/.ppt)

Cần cài LibreOffice (https://www.libreoffice.org). Tự tìm `soffice`; hoặc chỉ định:
  python converter/pptx_to_pdf.py a.pptx --soffice "C:\\Program Files\\LibreOffice\\program\\soffice.exe"
"""
import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CANDIDATES = [
    "soffice", "libreoffice",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
]


def find_soffice(custom):
    if custom:
        return shlex.split(custom, posix=(os.name != "nt"))
    env = os.environ.get("SOFFICE")
    if env:
        return shlex.split(env, posix=(os.name != "nt"))
    for c in CANDIDATES:
        p = shutil.which(c) or (c if os.path.isfile(c) else None)
        if p:
            return [p]
    return None


def convert_bytes(soffice, data, name):
    """Nhận bytes của .pptx/.ppt, trả về bytes PDF (dùng cho converter/server.py)."""
    ext = Path(name).suffix.lower()
    if ext not in (".pptx", ".ppt"):
        raise ValueError("Chỉ nhận .pptx / .ppt")
    with tempfile.TemporaryDirectory() as work:
        src = Path(work) / ("in" + ext)
        src.write_bytes(data)
        pdf = convert(soffice, src, Path(work) / "out")
        return pdf.read_bytes()


def collect(inputs):
    files = []
    for x in inputs:
        p = Path(x)
        if p.is_dir():
            files += sorted(f for f in p.rglob("*") if f.suffix.lower() in (".pptx", ".ppt"))
        elif p.is_file():
            files.append(p)
        else:
            print(f"! Không thấy: {x}", file=sys.stderr)
    return files


def convert(soffice, src, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    # profile riêng → không đụng LibreOffice đang mở, tránh treo
    with tempfile.TemporaryDirectory() as prof:
        uri = Path(prof).resolve().as_uri()
        cmd = soffice + [f"-env:UserInstallation={uri}", "--headless", "--convert-to", "pdf",
                         "--outdir", str(out_dir), str(src)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    pdf = out_dir / (src.stem + ".pdf")
    if r.returncode != 0 or not pdf.exists():
        raise RuntimeError((r.stderr or r.stdout or "LibreOffice không tạo được PDF").strip())
    return pdf


def main():
    ap = argparse.ArgumentParser(description="Đổi PPTX/PPT sang PDF bằng LibreOffice")
    ap.add_argument("inputs", nargs="+", help="file .pptx/.ppt hoặc thư mục")
    ap.add_argument("-o", "--out", help="thư mục lưu PDF (mặc định: cạnh file gốc)")
    ap.add_argument("--soffice", help="đường dẫn soffice nếu không tự tìm được")
    a = ap.parse_args()

    soffice = find_soffice(a.soffice)
    if not soffice:
        sys.exit("Không tìm thấy LibreOffice (soffice). Cài LibreOffice hoặc dùng --soffice <đường dẫn>.")
    files = collect(a.inputs)
    if not files:
        sys.exit("Không có file .pptx/.ppt nào để đổi.")

    ok = fail = 0
    for f in files:
        out_dir = Path(a.out) if a.out else f.parent
        try:
            pdf = convert(soffice, f, out_dir)
            print(f"✓ {f.name} → {pdf} ({pdf.stat().st_size // 1024} KB)")
            ok += 1
        except Exception as e:
            print(f"✗ {f.name}: {e}", file=sys.stderr)
            fail += 1
    print(f"Xong: {ok} thành công, {fail} lỗi.")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
