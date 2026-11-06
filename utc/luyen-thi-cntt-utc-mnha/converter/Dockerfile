# Dựng dịch vụ đổi PPTX → PDF để đặt lên server riêng (Render, Railway, VPS…). Vercel KHÔNG chạy được LibreOffice.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress fonts-liberation fonts-dejavu-core fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pptx_to_pdf.py server.py ./
ENV HOST=0.0.0.0 PORT=5001
EXPOSE 5001
CMD ["python", "server.py"]
