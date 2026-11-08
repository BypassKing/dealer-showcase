const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

class FakeFormData {
  constructor(form) { this.entries = [...(form?._fields || [])]; }
  delete(name) { this.entries = this.entries.filter(entry => entry[0] !== name); }
  set(name, value) { this.delete(name); this.entries.push([name, value]); }
  append(name, value, filename) { this.entries.push([name, value, filename]); }
  get(name) { return this.entries.find(entry => entry[0] === name)?.[1]; }
  getAll(name) { return this.entries.filter(entry => entry[0] === name).map(entry => entry[1]); }
}

function harness() {
  const revoked = [];
  let objectId = 0;
  class PhotoURL extends URL {
    static createObjectURL() { return `blob:photo-${objectId++}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const listeners = {};
  const context = vm.createContext({
    document: {
      querySelector: () => null,
      addEventListener: (name, listener) => (listeners[name] ||= []).push(listener),
      createElement: () => ({}),
    },
    window: { addEventListener() {} },
    localStorage: { getItem: () => '' },
    fetch: () => new Promise(() => {}),
    URL: PhotoURL,
    FormData: FakeFormData,
    alert: message => { throw new Error(`Unexpected alert: ${message}`); },
  });
  vm.runInContext(source, context);
  const fields = Object.fromEntries(['grid', 'count', 'summary', 'status', 'input'].map(key => [key, {
    innerHTML: '', textContent: '', disabled: false,
    classList: { toggle() {}, add() {}, remove() {} },
  }]));
  const events = {};
  const host = {
    innerHTML: '',
    querySelector: selector => fields[selector.slice('[data-photo-'.length, -1)],
    querySelectorAll: () => [],
    addEventListener: (name, listener) => { events[name] = listener; },
  };
  const image = { value: '', addEventListener() {}, focus() {} };
  const form = {
    elements: { image, featured: { checked: true } },
    _fields: [['photos', 'native-empty-file'], ['image', ''], ['main_image', 'legacy'], ['main_photo_index', '1']],
    querySelector: selector => selector === '[data-photo-manager]' ? host : null,
  };
  context.form = form;
  context.files = [];
  const run = code => vm.runInContext(code, context);
  const setup = images => { context.images = images; run('setupVehiclePhotoManager(form,images)'); };
  const click = (id, action) => {
    const card = { dataset: { photoId: id } };
    const button = { disabled: false, dataset: { photoAction: action }, closest: () => card };
    events.click({ target: { closest: () => button } });
  };
  return { context, run, form, host, fields, events, revoked, setup, click };
}

const file = name => ({ name, size: 100, type: 'image/jpeg' });
const plain = value => JSON.parse(JSON.stringify(value));

function editorHarness(h, id = '42') {
  const result = { textContent: '' };
  const button = { disabled: false, isConnected: true, textContent: '保存修改' };
  const query = h.form.querySelector;
  h.form.querySelector = selector => selector === '#vehicleSaveResult' ? result : selector === 'button[type="submit"]' ? button : query(selector);
  h.form.dataset = id ? { editId: id } : {};
  h.form.elements.title_zh = { value: '测试车辆', focus() {} };
  h.form.elements.title_en = { value: '' };
  const panel = { innerHTML: '' };
  h.context.document.querySelector = selector => selector === '#adminPanel' ? panel : null;
  h.run("vehiclePanel=()=>'<div>已保存</div>';bindPanel=()=>{};applyLanguage=()=>{}");
  const calls = [];
  const responses = [];
  h.context.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, `Unexpected request: ${url}`);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { json: async () => response };
  };
  const save = () => h.run('saveVehicleEditor({currentTarget:form,preventDefault(){}})');
  return { result, button, panel, calls, responses, save };
}

test('saving only reordered existing photos verifies the persisted detail before closing the editor', async () => {
  const h = harness();
  h.setup(['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg']);
  h.click('existing-2', 'cover');
  const editor = editorHarness(h);
  const saved = { id: 42, image: '/uploads/c.jpg', images: ['/uploads/c.jpg', '/uploads/a.jpg', '/uploads/b.jpg'] };
  editor.responses.push({ ok: true }, saved, [saved]);
  await editor.save();
  assert.deepEqual(editor.calls.map(call => [call.url, call.options.method || 'GET']), [
    ['/api/vehicles/42', 'PUT'], ['/api/vehicles/42', 'GET'], ['/api/vehicles', 'GET'],
  ]);
  assert.deepEqual(JSON.parse(editor.calls[0].options.body.get('photo_order')), saved.images);
  assert.ok(editor.calls.every(call => call.options.cache === 'no-store'));
  assert.equal(editor.panel.innerHTML, '<div>已保存</div>');
  h.context.saved = saved;
  h.setup(plain(h.run('vehicleImageList(saved)')));
  assert.deepEqual(plain(h.form._photoManager.items.map(item => item.ref)), saved.images);
});

test('an old backend that acknowledges saving but ignores photo_order cannot silently close the editor', async () => {
  const h = harness();
  h.setup(['/uploads/a.jpg', '/uploads/b.jpg']);
  h.click('existing-1', 'cover');
  const editor = editorHarness(h);
  editor.responses.push({ ok: true }, { id: 42, image: '/uploads/a.jpg', images: ['/uploads/a.jpg', '/uploads/b.jpg'] });
  await editor.save();
  assert.match(editor.result.textContent, /图片排序未正确保存/);
  assert.match(editor.result.textContent, /server\.js.*lib\/vehicle-photos\.js/);
  assert.equal(editor.panel.innerHTML, '');
  assert.equal(editor.button.disabled, true);
  assert.equal(h.form.dataset.saveNeedsReload, '1');
  await editor.save();
  assert.equal(editor.calls.length, 2, 'must not submit the same photos twice');
});

test('verification network failure after saving requires a refresh instead of uploading twice', async () => {
  const h = harness();
  h.setup(['/uploads/a.jpg']);
  h.context.files = [file('new.jpg')];
  h.run('addVehiclePhotos(form,files)');
  const editor = editorHarness(h, '');
  editor.responses.push({ id: 43 }, new Error('Network unavailable'));
  await editor.save();
  assert.equal(h.form.dataset.editId, '43');
  assert.match(editor.result.textContent, /车辆资料已提交/);
  assert.equal(editor.button.disabled, true);
  await editor.save();
  assert.equal(editor.calls.length, 2);
});

test('rejected saves retain pending photos and allow correction without a verification request', async () => {
  const h = harness();
  h.setup(['/uploads/a.jpg']);
  h.context.files = [file('new.jpg')];
  h.run('addVehiclePhotos(form,files)');
  const editor = editorHarness(h);
  editor.responses.push({ error: '照片顺序格式无效' });
  await editor.save();
  assert.equal(editor.result.textContent, '照片顺序格式无效');
  assert.equal(editor.button.disabled, false);
  assert.equal(editor.calls.length, 1);
  assert.equal(h.form._photoManager.items.length, 2);
  assert.deepEqual(h.revoked, []);
});

test('a new vehicle with mixed existing URL and upload verifies and releases its pending preview', async () => {
  const h = harness();
  h.setup([]);
  h.form.elements.image.value = 'https://example.com/car.jpg';
  h.run('syncVehiclePhotoLink(form)');
  h.context.files = [file('new.jpg')];
  h.run('addVehiclePhotos(form,files)');
  h.click('upload-1', 'cover');
  const editor = editorHarness(h, '');
  const saved = { id: 43, image: '/uploads/new.jpg', images: ['/uploads/new.jpg', 'https://example.com/car.jpg'] };
  editor.responses.push({ id: 43 }, saved, [saved]);
  await editor.save();
  assert.equal(editor.calls[0].url, '/api/vehicles');
  assert.equal(editor.calls[0].options.method, 'POST');
  assert.equal(h.form.dataset.editId, '43');
  assert.equal(editor.panel.innerHTML, '<div>已保存</div>');
  assert.deepEqual(h.revoked, ['blob:photo-0']);
});

test('order verification detects a stale cover, missing photos and shifted old photos', () => {
  const h = harness();
  h.context.expected = ['/uploads/b.jpg', 'upload:0', '/uploads/a.jpg'];
  const valid = { image: '/uploads/b.jpg', images: ['/uploads/b.jpg', '/uploads/new.jpg', '/uploads/a.jpg'] };
  h.context.vehicle = valid;
  assert.equal(h.run('vehiclePhotoOrderMatches(vehicle,expected)'), true);
  for (const invalid of [
    { ...valid, image: '/uploads/a.jpg' },
    { ...valid, images: ['/uploads/b.jpg', '/uploads/a.jpg', '/uploads/new.jpg'] },
    { ...valid, images: ['/uploads/b.jpg', '/uploads/a.jpg'] },
    { ...valid, images: ['/uploads/b.jpg', '/uploads/b.jpg', '/uploads/a.jpg'] },
    { ...valid, images: ['/uploads/b.jpg', 'javascript:alert(1)', '/uploads/a.jpg'] },
  ]) {
    h.context.vehicle = invalid;
    assert.equal(h.run('vehiclePhotoOrderMatches(vehicle,expected)'), false);
  }
  assert.equal(h.run("vehiclePhotoOrderMatches({image:'',images:[]},[])"), true);
});

test('saved image order remains authoritative when the legacy cover is stale', () => {
  const h = harness();
  h.context.vehicle = { image: '/uploads/a.jpg', images: ['/uploads/c.jpg', '/uploads/b.jpg', '/uploads/a.jpg'] };
  assert.deepEqual(plain(h.run('vehicleImageList(vehicle)')), ['/uploads/c.jpg', '/uploads/b.jpg', '/uploads/a.jpg']);
  h.setup(plain(h.run('vehicleImageList(vehicle)')));
  assert.deepEqual(JSON.parse(h.run('vehicleEditorFormData(form)').get('photo_order')), ['/uploads/c.jpg', '/uploads/b.jpg', '/uploads/a.jpg']);
  h.context.vehicle = { image: '/uploads/legacy.jpg', images: ['/uploads/b.jpg', '/uploads/b.jpg', 'javascript:alert(1)'] };
  assert.deepEqual(plain(h.run('vehicleImageList(vehicle)')), ['/uploads/b.jpg', '/uploads/legacy.jpg']);
  assert.deepEqual(plain(h.run("vehicleImageList({image:'/uploads/only.jpg'})")), ['/uploads/only.jpg']);
});

test('photo manager appends separate upload selections without replacing saved photos', () => {
  const h = harness();
  h.setup(['/uploads/old-a.jpg', '/uploads/old-b.jpg']);
  h.context.files = [file('new-a.jpg')];
  assert.equal(h.run('addVehiclePhotos(form,files)'), true);
  h.context.files = [file('new-b.jpg')];
  assert.equal(h.run('addVehiclePhotos(form,files)'), true);
  assert.deepEqual(plain(h.form._photoManager.items.map(item => item.ref || item.file.name)), [
    '/uploads/old-a.jpg', '/uploads/old-b.jpg', 'new-a.jpg', 'new-b.jpg',
  ]);
  assert.equal(h.fields.count.textContent, '4 / 20 张');
  assert.match(h.fields.grid.innerHTML, /data-photo-action="cover"/);
  assert.equal((h.fields.grid.innerHTML.match(/data-photo-action="remove"/g) || []).length, 2);
});

test('cover, previous and next actions preserve every photo and set the first photo as cover', () => {
  const h = harness();
  h.setup(['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg']);
  h.click('existing-2', 'cover');
  h.click('existing-0', 'next');
  h.click('existing-1', 'previous');
  assert.deepEqual(plain(h.form._photoManager.items.map(item => item.ref)), ['/uploads/b.jpg', '/uploads/c.jpg', '/uploads/a.jpg']);
  assert.match(h.fields.grid.innerHTML, /is-cover" data-photo-id="existing-1"/);
  assert.equal(h.run("moveVehiclePhoto(form._photoManager.items,'missing',0)"), false);
});

test('desktop drag/drop changes the same photo state used by mobile buttons', () => {
  const h = harness();
  h.setup(['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg']);
  const card = id => ({ dataset: { photoId: id }, classList: { add() {} } });
  const from = card('existing-2');
  const to = card('existing-0');
  const transfer = { setData() {} };
  h.events.dragstart({ target: { closest: selector => selector === 'button' ? null : from }, dataTransfer: transfer });
  h.events.dragover({ target: { closest: () => to }, dataTransfer: transfer, preventDefault() {} });
  h.events.drop({ target: { closest: () => to }, preventDefault() {} });
  assert.deepEqual(plain(h.form._photoManager.items.map(item => item.ref)), ['/uploads/c.jpg', '/uploads/a.jpg', '/uploads/b.jpg']);
  assert.equal(transfer.effectAllowed, 'move');
  assert.equal(transfer.dropEffect, 'move');
});

test('pending photo removal releases previews but saved photos cannot be removed', () => {
  const h = harness();
  h.setup(['/uploads/old.jpg']);
  h.context.files = [file('new.jpg')];
  h.run('addVehiclePhotos(form,files)');
  h.click('existing-0', 'remove');
  assert.equal(h.form._photoManager.items.length, 2);
  h.click('upload-0', 'remove');
  assert.equal(h.form._photoManager.items.length, 1);
  assert.deepEqual(h.revoked, ['blob:photo-0']);
});

test('multipart payload includes all old photos and only currently pending files in display order', () => {
  const h = harness();
  h.setup(['/uploads/old-a.jpg', '/uploads/old-b.jpg']);
  h.context.files = [file('new-a.jpg'), file('new-b.jpg')];
  h.run('addVehiclePhotos(form,files)');
  h.click('upload-1', 'cover');
  h.click('upload-0', 'previous');
  const payload = h.run('vehicleEditorFormData(form)');
  assert.deepEqual(JSON.parse(payload.get('photo_order')), ['upload:0', '/uploads/old-a.jpg', 'upload:1', '/uploads/old-b.jpg']);
  assert.deepEqual(payload.getAll('photos').map(item => item.name), ['new-b.jpg', 'new-a.jpg']);
  assert.equal(payload.get('featured'), 'true');
  assert.equal(payload.get('main_image'), undefined);
  assert.equal(payload.get('main_photo_index'), undefined);
});

test('new vehicle image URL participates in ordering and can be removed before save', () => {
  const h = harness();
  h.setup([]);
  h.form.elements.image.value = 'https://example.com/car.jpg';
  assert.equal(h.run('syncVehiclePhotoLink(form)'), true);
  h.context.files = [file('new.jpg')];
  h.run('addVehiclePhotos(form,files)');
  h.click('upload-1', 'cover');
  assert.deepEqual(plain(h.run('vehiclePhotoPayload(form._photoManager.items).order')), ['upload:0', 'https://example.com/car.jpg']);
  h.click('link-0', 'remove');
  assert.equal(h.form.elements.image.value, '');
  assert.equal(h.form._photoManager.items.length, 1);
  h.form.elements.image.value = 'javascript:alert(1)';
  assert.equal(h.run('syncVehiclePhotoLink(form)'), false);
  assert.match(h.fields.status.textContent, /HTTP/);
});

test('photo count and file validation are enforced across every upload batch', () => {
  const h = harness();
  h.setup(Array.from({ length: 19 }, (_, index) => `/uploads/old-${index}.jpg`));
  h.context.files = [file('last.jpg')];
  assert.equal(h.run('addVehiclePhotos(form,files)'), true);
  assert.equal(h.fields.input.disabled, true);
  h.context.files = [file('overflow.jpg')];
  assert.equal(h.run('addVehiclePhotos(form,files)'), false);
  assert.equal(h.form._photoManager.items.length, 20);
  assert.match(h.fields.status.textContent, /20/);
  h.click('upload-0', 'remove');
  assert.equal(h.fields.input.disabled, false);
  h.context.files = [{ ...file('bad.svg'), type: 'image/svg+xml' }];
  assert.equal(h.run('addVehiclePhotos(form,files)'), false);
  h.context.files = [{ ...file('big.jpg'), size: 12 * 1024 * 1024 + 1 }];
  assert.equal(h.run('addVehiclePhotos(form,files)'), false);
});

test('closing photo management releases all pending previews and filenames are escaped', () => {
  const h = harness();
  h.setup([]);
  h.context.files = [file('<img src=x onerror=alert(1)>.jpg')];
  h.run('addVehiclePhotos(form,files)');
  assert.doesNotMatch(h.fields.grid.innerHTML, /<img src=x onerror/);
  assert.match(h.fields.grid.innerHTML, /&lt;img/);
  h.run('cleanupVehiclePhotoManager(form)');
  assert.equal(h.form._photoManager, undefined);
  assert.deepEqual(h.revoked, ['blob:photo-0']);
});

test('new and edit vehicle forms share the same manager and single multipart save workflow', () => {
  const h = harness();
  for (const editing of [false, true]) {
    const markup = h.run(`vehicleEditorMarkup(${editing})`);
    assert.equal((markup.match(/data-photo-manager/g) || []).length, 1);
    assert.match(markup, /name="displacement"/);
    assert.match(markup, /type="submit"/);
  }
  const save = source.slice(source.indexOf('async function saveVehicleEditor('), source.indexOf("document.addEventListener('click',event=>"));
  assert.match(save, /method:id\?'PUT':'POST',body/);
  assert.doesNotMatch(save, /\/photos|application\/json/);
  assert.doesNotMatch(source, /function renderVehiclePhotoPreview/);
});
