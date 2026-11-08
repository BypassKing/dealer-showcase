const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const photos = import('../lib/vehicle-photos.js');

test('uploaded filenames use safe image extensions rather than user-provided suffixes', async () => {
  const { uploadImageExtension } = await photos;
  assert.equal(uploadImageExtension('image/jpeg'), '.jpg');
  assert.equal(uploadImageExtension('image/png'), '.png');
  assert.equal(uploadImageExtension('image/webp'), '.webp');
  assert.equal(uploadImageExtension('image/gif'), '.gif');
  for (const type of ['text/html', 'image/svg+xml', 'toString', '__proto__', '', undefined]) assert.equal(uploadImageExtension(type), '');
  assert.doesNotMatch(serverSource, /path\.extname\(file\.originalname\)/);
});

function routeSource(method, route) {
  const escapedMethod = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = serverSource.search(new RegExp(`app\\.${escapedMethod}\\('${escapedRoute}'`));
  assert.notEqual(start, -1, `${method.toUpperCase()} ${route} route is missing`);
  const tail = serverSource.slice(start);
  const next = tail.indexOf('app.', 4);
  return next === -1 ? tail : tail.slice(0, next);
}

async function persistedRoutes(t, vehicles) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealer-photo-order-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'site.json');
  fs.writeFileSync(filename, JSON.stringify({ vehicles, contacts: [] }));
  const readData = () => JSON.parse(fs.readFileSync(filename, 'utf8'));
  let writes = 0;
  const writeData = data => { fs.writeFileSync(filename, JSON.stringify(data)); writes++; };
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'put', 'post']) app[method] = (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1));
  const context = vm.createContext({
    app, readData, writeData, ...await photos,
    requireAdmin() {}, upload: { array: () => () => {} }, fs,
    vehicleUploadError: (_req, res, error) => res.status(400).json({ error: error.message }),
  });
  for (const [method, route] of [['put', '/api/vehicles/:id'], ['post', '/api/vehicles'], ['get', '/api/vehicles'], ['get', '/api/vehicles/:id']]) {
    vm.runInContext(routeSource(method, route), context);
  }
  const request = (method, route, body = {}, files = []) => {
    const response = { statusCode: 200, value: null, status(code) { this.statusCode = code; return this; }, json(value) { this.value = value; return this; } };
    routes.get(`${method} ${route}`)({ params: { id: '42' }, body, files }, response);
    return response;
  };
  return { readData, request, writes: () => writes };
}

test('editing only existing photos persists their full order and cover across fresh JSON reads', async t => {
  const old = ['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg'];
  const h = await persistedRoutes(t, [{ id: 42, title: 'Original title', image: old[0], images: old, featured: true }]);
  const order = [old[2], old[0], old[1]];
  const response = h.request('put', '/api/vehicles/:id', { title: 'Updated title', photo_order: JSON.stringify(order) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.value.ok, true);
  assert.deepEqual(plain(response.value.images), order);
  assert.equal(h.writes(), 1);
  const saved = h.readData().vehicles[0];
  assert.deepEqual(saved.images, order);
  assert.equal(saved.image, order[0]);
  assert.equal(saved.title, 'Updated title');
  assert.equal(saved.featured, true);
  assert.equal(Object.hasOwn(saved, 'photo_order'), false);
  const detail = h.request('get', '/api/vehicles/:id').value;
  const inventory = h.request('get', '/api/vehicles').value;
  assert.deepEqual(plain(detail.images), order);
  assert.deepEqual(plain(inventory[0].images), order);
  assert.equal(detail.image, order[0]);
  // Reopen, move a non-cover photo, and save again without uploading anything.
  const again = [order[0], order[2], order[1]];
  h.request('put', '/api/vehicles/:id', { photo_order: JSON.stringify(again) });
  assert.deepEqual(h.readData().vehicles[0].images, again);
  h.request('put', '/api/vehicles/:id', { title: 'Text-only edit' });
  assert.deepEqual(h.readData().vehicles[0].images, again);
});

test('editing mixed old and uploaded photos persists order while invalid permutations never write', async t => {
  const old = ['/uploads/a.jpg', '/uploads/b.jpg'];
  const h = await persistedRoutes(t, [{ id: 42, image: old[0], images: old }]);
  const order = ['upload:1', old[1], 'upload:0', old[0]];
  const response = h.request('put', '/api/vehicles/:id', { photo_order: JSON.stringify(order) }, [{ filename: 'new-a.jpg' }, { filename: 'new-b.jpg' }]);
  assert.equal(response.statusCode, 200);
  const saved = h.readData().vehicles[0];
  assert.deepEqual(saved.images, ['/uploads/new-b.jpg', old[1], '/uploads/new-a.jpg', old[0]]);
  assert.equal(saved.image, '/uploads/new-b.jpg');
  const rejected = h.request('put', '/api/vehicles/:id', { photo_order: JSON.stringify([old[0], '/uploads/not-owned.jpg']) });
  assert.equal(rejected.statusCode, 400);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.readData().vehicles[0], saved);
});

test('vehicle API responses explicitly disable caching for lists and detail routes', () => {
  const middlewareSource = serverSource.split(/\r?\n/).find(line => line.startsWith("app.use('/api/vehicles',"));
  assert.ok(middlewareSource);
  let middleware;
  vm.runInNewContext(middlewareSource, { app: { use: (route, handler) => { assert.equal(route, '/api/vehicles'); middleware = handler; } } });
  const headers = {};
  let next = false;
  middleware({}, { set: (name, value) => { headers[name] = value; } }, () => { next = true; });
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(next, true);
});

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('vehicle photo API routes validate and persist the main-photo contract', () => {
  const create = routeSource('post', '/api/vehicles');
  const update = routeSource('put', '/api/vehicles/:id');
  const append = routeSource('post', '/api/vehicles/:id/photos');
  assert.match(create, /main_photo_index/);
  assert.match(create, /main_image/);
  assert.match(update, /main_image/);
  assert.match(update, /main_photo_index/);
  assert.match(append, /main_image/);
  assert.match(append, /main_photo_index/);
  for (const source of [create, update, append]) {
    assert.match(source, /photo_order:req\.body\.photo_order/);
    assert.match(source, /upload\.array\('photos',20\)/);
    assert.match(source, /vehicleUploadError|removeUploadedFiles/);
    assert.doesNotMatch(source, /req\.body\.images\s*(?:\?\||&&|=)/);
  }
  assert.match(create, /delete cleanBody\.photo_order/);
  assert.match(update, /delete cleanBody\.photo_order/);
});

test('selecting a saved photo reorders it to the cover without dropping photos', async () => {
  const { selectVehiclePhotos } = await photos;
  const original = ['/uploads/a.jpg', '/uploads/b.jpg'];
  const added = ['/uploads/c.jpg'];
  const selected = selectVehiclePhotos(original, added, { main_image: original[1] });
  assert.equal(selected.image, original[1]);
  assert.equal(selected.images[0], selected.image);
  assert.deepEqual(selected.images, ['/uploads/b.jpg', '/uploads/a.jpg', '/uploads/c.jpg']);
});

test('appending photos without a selection preserves the old cover', async () => {
  const { selectVehiclePhotos } = await photos;
  const old = ['/uploads/cover.jpg', '/uploads/inside.jpg'];
  const result = selectVehiclePhotos(old, ['/uploads/new.jpg']);
  assert.equal(result.image, old[0]);
  assert.deepEqual(result.images, [...old, '/uploads/new.jpg']);
});

test('new-upload index supports strict string or numeric values and reorders photos', async () => {
  const { selectVehiclePhotos } = await photos;
  const selected = selectVehiclePhotos(['/uploads/old.jpg'], ['/uploads/new-a.jpg', '/uploads/new-b.jpg'], { main_photo_index: '1' });
  assert.equal(selected.image, '/uploads/new-b.jpg');
  assert.equal(selected.images[0], selected.image);
  assert.deepEqual(selected.images, ['/uploads/new-b.jpg', '/uploads/old.jpg', '/uploads/new-a.jpg']);
  assert.equal(selectVehiclePhotos([], ['/uploads/new.jpg'], { main_photo_index: 0 }).image, '/uploads/new.jpg');
});

test('invalid, ambiguous, non-owned, or unsafe main-photo selections are rejected', async () => {
  const { selectVehiclePhotos } = await photos;
  const old = ['/uploads/own.jpg'];
  const added = ['/uploads/new.jpg'];
  for (const index of ['-1', '1.5', '01', ' 0', '2', 1.5, null, {}]) {
    assert.throws(() => selectVehiclePhotos(old, added, { main_photo_index: index }));
  }
  assert.throws(() => selectVehiclePhotos(old, added, { main_image: '/uploads/other.jpg' }));
  assert.throws(() => selectVehiclePhotos(old, added, { main_image: 'javascript:alert(1)' }));
  assert.throws(() => selectVehiclePhotos(old, added, { main_image: old[0], main_photo_index: '0' }));
});

test('legacy image-only vehicles remain available and become a consistent image list', async () => {
  const { existingImages, selectVehiclePhotos } = await photos;
  const old = existingImages({ image: '/uploads/legacy.jpg' });
  const result = selectVehiclePhotos(old, ['/uploads/added.jpg']);
  assert.deepEqual(result.images, ['/uploads/legacy.jpg', '/uploads/added.jpg']);
  assert.equal(result.image, result.images[0]);
});

test('reading and saving an existing vehicle does not move a stale legacy cover back to the front', async () => {
  const { existingImages, selectVehiclePhotos } = await photos;
  const vehicle = { image: '/uploads/a.jpg', images: ['/uploads/c.jpg', '/uploads/b.jpg', '/uploads/a.jpg'] };
  assert.deepEqual(existingImages(vehicle), vehicle.images);
  const saved = selectVehiclePhotos(existingImages(vehicle), []);
  assert.deepEqual(saved.images, vehicle.images);
  assert.equal(saved.image, '/uploads/c.jpg');
  assert.deepEqual(existingImages({ image: '/uploads/legacy.jpg', images: ['/uploads/a.jpg'] }), ['/uploads/a.jpg', '/uploads/legacy.jpg']);
});

test('photo cap rejects overflow rather than silently dropping the selected image', async () => {
  const { selectVehiclePhotos } = await photos;
  const old = Array.from({ length: 20 }, (_, i) => `/uploads/old-${i}.jpg`);
  assert.throws(() => selectVehiclePhotos(old, ['/uploads/new.jpg'], { main_photo_index: '0' }), /20/);
  const exactlyFull = selectVehiclePhotos(old.slice(0, 19), ['/uploads/new.jpg'], { main_photo_index: '0' });
  assert.equal(exactlyFull.images.length, 20);
  assert.equal(exactlyFull.images[0], '/uploads/new.jpg');
});

test('safe image references exclude executable and protocol-relative values', async () => {
  const { isSafeImageReference } = await photos;
  assert.equal(isSafeImageReference('/uploads/ok-1.jpg'), true);
  assert.equal(isSafeImageReference('https://example.com/photo.jpg'), true);
  assert.equal(isSafeImageReference('javascript:alert(1)'), false);
  assert.equal(isSafeImageReference('data:image/png;base64,abc'), false);
  assert.equal(isSafeImageReference('//example.com/photo.jpg'), false);
});

test('photo_order accepts a complete mixed permutation and selects its first image as cover', async () => {
  const { selectVehiclePhotos } = await photos;
  const old = ['/uploads/old-a.jpg', '/uploads/old-b.jpg'];
  const added = ['/uploads/new-a.jpg', '/uploads/new-b.jpg'];
  const order = ['upload:1', old[1], 'upload:0', old[0]];
  const expected = { image: added[1], images: [added[1], old[1], added[0], old[0]] };
  assert.deepEqual(selectVehiclePhotos(old, added, { photo_order: order }), expected);
  assert.deepEqual(selectVehiclePhotos(old, added, { photo_order: JSON.stringify(order) }), expected);
  assert.deepEqual(selectVehiclePhotos(old, [], { photo_order: [old[1], old[0]] }).images, [old[1], old[0]]);
  assert.deepEqual(selectVehiclePhotos([], added, { photo_order: ['upload:1', 'upload:0'] }).images, [added[1], added[0]]);
  assert.deepEqual(selectVehiclePhotos([], [], { photo_order: [] }), { images: [], image: '' });
});

test('photo_order must preserve every owned and uploaded image exactly once', async () => {
  const { selectVehiclePhotos } = await photos;
  const old = ['/uploads/old-a.jpg', '/uploads/old-b.jpg'];
  const added = ['/uploads/new.jpg'];
  const invalid = [
    [old[0], 'upload:0'],
    [old[0], old[0], 'upload:0'],
    [old[0], old[1], 'upload:1'],
    [old[0], old[1], 'upload:-1'],
    [old[0], old[1], 'upload:00'],
    [old[0], old[1], 'upload:0.0'],
    [old[0], old[1], '/uploads/other.jpg'],
    [old[0], old[1], added[0]],
    [old[0], old[1], 0],
    [old[0], old[1], { token: 'upload:0' }],
    null, '', 'not-json', '{}', 0, {},
    [old[0], old[1], 'upload:0', 'upload:1']
  ];
  for (const order of invalid) assert.throws(() => selectVehiclePhotos(old, added, { photo_order: order }));
  assert.throws(() => selectVehiclePhotos([old[0], old[0]], [], { photo_order: [old[0], old[0]] }));
  assert.throws(() => selectVehiclePhotos(old, [old[0]], { photo_order: [old[0], old[1], 'upload:0'] }));
});

test('photo_order validates optional legacy cover selections and rejects conflicts', async () => {
  const { selectVehiclePhotos } = await photos;
  const old = ['/uploads/old-a.jpg', '/uploads/old-b.jpg'];
  const added = ['/uploads/new.jpg'];
  const oldFirst = [old[1], old[0], 'upload:0'];
  const newFirst = ['upload:0', ...old];
  assert.equal(selectVehiclePhotos(old, added, { photo_order: oldFirst, main_image: old[1] }).image, old[1]);
  assert.equal(selectVehiclePhotos(old, added, { photo_order: newFirst, main_photo_index: '0' }).image, added[0]);
  assert.throws(() => selectVehiclePhotos(old, added, { photo_order: oldFirst, main_image: old[0] }), /第一张/);
  assert.throws(() => selectVehiclePhotos(old, added, { photo_order: oldFirst, main_photo_index: '0' }), /第一张/);
  assert.throws(() => selectVehiclePhotos(old, added, { photo_order: newFirst, main_image: '/uploads/other.jpg' }), /已保存/);
  assert.throws(() => selectVehiclePhotos(old, added, { photo_order: newFirst, main_photo_index: '1' }), /索引/);
  assert.throws(() => selectVehiclePhotos(old, added, { photo_order: newFirst, main_photo_index: 0, main_image: old[0] }), /一种/);
});

test('photo_order enforces safe references and the twenty-photo limit', async () => {
  const { selectVehiclePhotos } = await photos;
  const old = Array.from({ length: 19 }, (_, index) => `/uploads/old-${index}.jpg`);
  const added = ['/uploads/new.jpg'];
  const full = selectVehiclePhotos(old, added, { photo_order: ['upload:0', ...old] });
  assert.equal(full.images.length, 20);
  assert.throws(() => selectVehiclePhotos([...old, '/uploads/old-19.jpg'], added, { photo_order: ['upload:0', ...old, '/uploads/old-19.jpg'] }), /20/);
  assert.throws(() => selectVehiclePhotos(['javascript:alert(1)'], [], { photo_order: ['javascript:alert(1)'] }), /无效/);
  assert.throws(() => selectVehiclePhotos([], ['data:image/png;base64,abc'], { photo_order: ['upload:0'] }), /无效/);
});
