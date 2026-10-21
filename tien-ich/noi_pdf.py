import io
import os
import re
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


# Hàm trích xuất số thứ tự hoặc chuỗi ký tự để sắp xếp danh sách file
def sort_key(filename):
  # Tìm số ở đầu tên file (ví dụ: "1. tailieu.pdf" -> 1)
  match = re.match(r"^(\d+)", filename)
  if match:
    return (0, int(match.group(1)), filename.lower())
  # Nếu không có số ở đầu, xếp theo bảng chữ cái A-Z
  return (1, 0, filename.lower())


# Hàm tạo một trang PDF tạm chứa text tên file ở góc trên bên trái
def create_header_pdf(text, width, height):
  packet = io.BytesIO()
  # Tạo canvas với kích thước chuẩn của trang gốc
  can = canvas.Canvas(packet, pagesize=(width, height))
  can.setFont("Helvetica", 9)
  can.setFillColorRGB(0.5, 0.5, 0.5)  # Màu xám nhạt giống Chrome

  # Tọa độ góc trên bên trái (cách lề trái 36pt, cách lề trên 20pt)
  x = 36
  y = height - 20

  can.drawString(x, y, text)
  can.save()
  packet.seek(0)
  return PdfReader(packet).pages[0]


def merge_pdfs_with_header(folder_path, output_filename="ket_qua_noi.pdf"):
  # Lấy danh sách file .pdf trong thư mục (loại trừ file kết quả nếu đã có)
  pdf_files = [
      f
      for f in os.listdir(folder_path)
      if f.endswith(".pdf") and f != output_filename
  ]

  if not pdf_files:
    print("Không tìm thấy file PDF nào trong thư mục!")
    return

  # Sắp xếp danh sách file theo STT hoặc Alpha-B
  pdf_files.sort(key=sort_key)

  writer = PdfWriter()
  print("Thứ tự nối các file:")

  for idx, filename in enumerate(pdf_files, 1):
    print(f"{idx}. {filename}")
    file_path = os.path.join(folder_path, filename)

    try:
      reader = PdfReader(file_path)
      # Lấy tên file không bao gồm phần đuôi .pdf để in lên trang
      display_name = os.path.splitext(filename)[0]

      for page in reader.pages:
        # Lấy kích thước thực tế của trang hiện tại
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)

        # Tạo đè chữ tên file lên trang hiện tại
        header_page = create_header_pdf(display_name, width, height)
        page.merge_page(header_page)

        # Thêm trang đã đóng dấu vào file tổng
        writer.add_page(page)

    except Exception as e:
      print(f"Lỗi khi đọc file {filename}: {e}")

  # Xuất file kết quả tổng hợp
  output_path = os.path.join(folder_path, output_filename)
  with open(output_path, "wb") as f_out:
    writer.write(f_out)

  print(f"\n Thành công! File tổng hợp đã được lưu tại: {output_filename}")


# Chạy ngay tại thư mục hiện tại
if __name__ == "__main__":
  merge_pdfs_with_header(".")
