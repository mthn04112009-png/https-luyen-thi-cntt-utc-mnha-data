// Test: loại dữ liệu "flashcards" của githubStore (nạp từ GitHub, chỉ mục trong RAM, ghi ngược khi sửa chỉ mục)
const h = require('./harness');
const assert = require('assert');
const { ObjectId, repo, put, subjects } = h;
const R = h.ROOT;
const store = require(R + '/services/githubStore');
const Flashcard = require(R + '/models/Flashcard');
const sync = require(R + '/services/githubSyncService');
const hex = () => new ObjectId().toHexString();

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.stack.split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; } };

const subjId = hex(), uk = hex(), adm = hex(), F1 = hex(), F2 = hex();
subjects.push({ _id: new ObjectId(subjId), slug: 'tieng-anh-12', userKey: new ObjectId(uk) });
const card = (i) => ({ id: 'c' + i, front: 'w' + i, back: 'nghĩa ' + i, ipa: '', image: '' });

put('subjects/tieng-anh-12/flashcards/unit-1_1760000000.json', {
  type: 'flashcard', flashcardId: F1, title: 'Unit 1', slug: 'unit-1', mode: 'language', language: 'en-US', isPublished: true,
  createdBy: adm, createdAt: '2026-10-01T00:00:00Z', cards: [card(1), card(2), card(3)]
});
put('subjects/tieng-anh-12/flashcards/ly-thuyet_1760000100.json', {
  flashcardId: F2, title: 'Lý thuyết', mode: 'theory', language: 'zh-CN', isPublished: false, cards: [card(1)]
});
put('subjects/tieng-anh-12/flashcards/hong_1.json', { title: 'Không có id, mode lạ', mode: 'xxx', language: '!!', cards: 'sai' });
put('subjects/khong-co/flashcards/x_1.json', { title: 'môn không tồn tại', cards: [card(1)] });
put('subjects/tieng-anh-12/lessons/de-1.json', { title: 'Đề 1' });

(async () => {
  console.log('Flashcards');
  await t('nạp được bộ thẻ, bỏ qua bộ thuộc môn không tồn tại', async () => {
    await sync.syncKinds(['flashcards']);
    assert.strictEqual(await Flashcard.countDocuments({}), 3);
  });
  await t('field mapping: chỉ mục trong RAM, KHÔNG giữ nội dung thẻ', async () => {
    const f = await Flashcard.findById(F1).lean();
    assert.strictEqual(f.title, 'Unit 1'); assert.strictEqual(f.mode, 'language'); assert.strictEqual(f.language, 'en-US');
    assert.strictEqual(f.cardCount, 3); assert.strictEqual(f.cards, undefined);
    assert.strictEqual(String(f.userKey), uk, 'userKey lấy từ môn học'); assert.strictEqual(String(f.subjectId), subjId);
    assert.strictEqual(f.githubFile, 'subjects/tieng-anh-12/flashcards/unit-1_1760000000.json');
    assert.strictEqual(f.isPublished, true); assert.strictEqual(f.isDeleted, false);
    const g = await Flashcard.findById(F2).lean();
    assert.strictEqual(g.mode, 'theory'); assert.strictEqual(g.isPublished, false); assert.strictEqual(g.cardCount, 1);
  });
  await t('file hỏng: mode lạ → language, ngôn ngữ sai → mặc định, cards sai → 0 thẻ, id ổn định', async () => {
    const a = await Flashcard.findOne({ title: /mode lạ/ }).lean();
    assert.strictEqual(a.mode, 'language'); assert.strictEqual(a.language, 'en-US'); assert.strictEqual(a.cardCount, 0);
    store._reset(); await sync.syncKinds(null);
    const b = await Flashcard.findOne({ title: /mode lạ/ }).lean();
    assert.strictEqual(a._id.toHexString(), b._id.toHexString());
  });
  await t('lọc như Mongoose: theo môn, công khai, userKey, sort', async () => {
    assert.strictEqual((await Flashcard.find({ subjectId: new ObjectId(subjId), isDeleted: { $ne: true } })).length, 3);
    assert.strictEqual((await Flashcard.find({ isPublished: true })).length, 2);
    assert.strictEqual((await Flashcard.find({ userKey: new ObjectId(uk) })).length, 3);
    assert.strictEqual(await Flashcard.countDocuments({ mode: 'theory' }), 1);
  });
  await t('lessons vẫn nạp bình thường cùng lúc', async () => {
    const Lesson = require(R + '/models/Lesson');
    await sync.syncKinds(['lessons']);
    assert.strictEqual(await Lesson.countDocuments({}), 1);
  });
  await t('đổi công khai → commit patch vào JSON, giữ nguyên danh sách thẻ', async () => {
    const before = repo.calls.write;
    await Flashcard.updateOne({ _id: new ObjectId(F2) }, { $set: { isPublished: true } });
    assert.ok(repo.calls.write > before, 'phải ghi GitHub');
    const f = JSON.parse(repo.files.get('subjects/tieng-anh-12/flashcards/ly-thuyet_1760000100.json').text);
    assert.strictEqual(f.isPublished, true); assert.strictEqual(f.cards.length, 1); assert.strictEqual(f.title, 'Lý thuyết');
  });
  await t('webhook: thêm / xoá file flashcard cập nhật chỉ mục', async () => {
    put('subjects/tieng-anh-12/flashcards/moi_2.json', { flashcardId: hex(), title: 'Mới', cards: [card(1), card(2)] });
    const r = await store.applyPush({ ref: 'refs/heads/main', commits: [{ added: ['subjects/tieng-anh-12/flashcards/moi_2.json'], modified: [], removed: [] }] });
    assert.ok(r, 'applyPush phải trả kết quả');
    assert.strictEqual(await Flashcard.countDocuments({ title: 'Mới' }), 1);
    repo.files.delete('subjects/tieng-anh-12/flashcards/moi_2.json');
    await store.applyPush({ ref: 'refs/heads/main', commits: [{ added: [], modified: [], removed: ['subjects/tieng-anh-12/flashcards/moi_2.json'] }] });
    assert.strictEqual(await Flashcard.countDocuments({ title: 'Mới' }), 0);
  });

  console.log('\n' + pass + ' test đạt');
})();
