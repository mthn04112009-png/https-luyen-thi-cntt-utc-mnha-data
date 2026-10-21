import os
from docx2pdf import convert


def convert_and_delete_word_files(folder_path):
  # Kiểm tra đường dẫn có tồn tại không
  if not os.path.exists(folder_path):
    print("Thư mục không tồn tại!")
    return

  # Duyệt qua tất cả các file trong thư mục
  for filename in os.listdir(folder_path):
    # Chỉ xử lý các file có đuôi .docx hoặc .doc (bỏ qua file tạm bắt đầu bằng ~$)
    if (filename.endswith(".docx") or filename.endswith(".doc")) and (
        not filename.startswith("~$")
    ):
      docx_path = os.path.join(folder_path, filename)

      # Tạo tên file PDF mới giữ nguyên tên gốc
      # os.path.splitext tách phần tên và phần đuôi (ví dụ: 'tailieu', '.docx')
      name_without_ext = os.path.splitext(filename)[0]
      pdf_filename = name_without_ext + ".pdf"
      pdf_path = os.path.join(folder_path, pdf_filename)

      try:
        print(f"Đang chuyển đổi: {filename} -> {pdf_filename}")
        convert(docx_path, pdf_path)

        # Xóa file Word gốc sau khi chuyển đổi thành công
        os.remove(docx_path)
        print(f"Đã xoá file Word gốc: {filename}")

      except Exception as e:
        print(f"Lỗi khi xử lý {filename}: {e}")


# Dấu chấm "." đại diện cho chính thư mục FileBaiTap đang đứng
target_folder = "."
convert_and_delete_word_files(target_folder)
