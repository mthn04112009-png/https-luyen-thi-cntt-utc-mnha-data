# Converter PPTX → PDF

Cần LibreOffice (https://www.libreoffice.org) và Python 3.8+. Không cần cài thư viện Python nào.

```bash
python converter/server.py                 # http://localhost:5001
```

Trong `.env` của web:

```
PPTX_CONVERTER_URL=http://localhost:5001
PPTX_CONVERTER_TOKEN=            # tuỳ chọn, trùng CONVERTER_TOKEN của converter
```

Biến của converter: `PORT`, `HOST`, `CONVERTER_TOKEN`, `ALLOWED_ORIGINS`, `MAX_MB`, `SOFFICE`.
Đặt lên server riêng: dựng bằng `converter/Dockerfile`, đặt `CONVERTER_TOKEN` và `ALLOWED_ORIGINS=https://ten-web.vercel.app`, rồi trỏ `PPTX_CONVERTER_URL` tới địa chỉ đó (phải là https).
