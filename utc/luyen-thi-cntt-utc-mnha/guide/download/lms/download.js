(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const viewer = document.querySelector('.pdfViewer_20aad523');

  // Tính khoảng cách giữa các trang
  viewer.scrollTop = 0;
  await sleep(1000);
  const tops = [...document.querySelectorAll('.page_d3fbf39d')]
    .map(p => parseFloat(p.style.top)).sort((a, b) => a - b);
  
  if (tops.length < 2) {
    console.error('Không tìm đủ số trang để tính khoảng cách (pitch)!');
    return;
  }
  
  const firstTop = tops[0];
  const pitch = tops[1] - tops[0];

  let i = 0;
  let skipCount = 0; // Biến đếm số lần bỏ qua liên tiếp

  while (true) {
    // Nếu bị bỏ qua 5 lần liên tiếp thì dừng vòng lặp
    if (skipCount >= 5) {
      console.log(`Đã bỏ qua liên tiếp ${skipCount} lần. Dừng tải.`);
      break;
    }

    viewer.scrollTop = i * pitch;
    let img = null;
    
    for (let t = 0; t < 25 && !img; t++) {
      await sleep(300);
      const page = [...document.querySelectorAll('.page_d3fbf39d')]
        .find(p => Math.abs(parseFloat(p.style.top) - (firstTop + i * pitch)) < 5);
      const el = page && page.querySelector('img');
      if (el && el.src.startsWith('blob:') && el.complete) img = el;
    }
    
    if (!img) { 
      skipCount++; // Tăng số lần lỗi liên tiếp
      console.warn(`Bỏ qua trang ${i + 1} (Lần lỗi liên tiếp: ${skipCount}/5)`); 
      i++;
      continue; 
    }

    // Nếu tải thành công, reset lại biến đếm lỗi về 0
    skipCount = 0;

    const blob = await (await fetch(img.src)).blob();
    const ext = blob.type.includes('png') ? 'png' : 'jpg';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `slide_${String(i + 1).padStart(2, '0')}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log('Đã tải trang', i + 1);
    
    i++;
    await sleep(400);
  }
  console.log('Xong!');
})();
