const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const brands = import('../lib/brands.js');

function routeSource(method, route) {
  const escapedMethod = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = serverSource.search(new RegExp(`app\\.${escapedMethod}\\('${escapedRoute}'`));
  assert.notEqual(start, -1, `${method.toUpperCase()} ${route} route is missing`);
  const tail = serverSource.slice(start);
  const next = tail.indexOf('app.', 4);
  return next === -1 ? tail : tail.slice(0, next);
}

test('brand API exposes public GET and protected admin mutations', () => {
  assert.match(routeSource('get', '/api/brands'), /normalizeBrands/);
  assert.match(routeSource('post', '/api/brands'), /requireAdmin/);
  assert.match(routeSource('put', '/api/brands/:id'), /requireAdmin/);
  assert.match(routeSource('delete', '/api/brands/:id'), /requireAdmin/);
  assert.match(serverSource, /brands:defaultBrands/);
});

test('default brands have the public contract shape', async () => {
  const { defaultBrands, cloneDefaultBrands } = await brands;
  assert.ok(defaultBrands.length >= 15);
  for (const brand of defaultBrands) {
    assert.deepEqual(Object.keys(brand).sort(), ['id', 'name', 'name_zh', 'slug'].sort());
    assert.match(brand.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(brand.name && brand.name_zh);
  }
  assert.notEqual(cloneDefaultBrands(), defaultBrands);
});

test('brand validation keeps values plain text and requires a safe unique slug shape', async () => {
  const { cleanBrand, hasSlug } = await brands;
  assert.deepEqual(cleanBrand({ slug: 'toyota', name: 'Toyota', name_zh: '丰田' }), { slug: 'toyota', name: 'Toyota', name_zh: '丰田' });
  assert.throws(() => cleanBrand({ slug: 'Toyota', name: 'Toyota' }));
  assert.throws(() => cleanBrand({ slug: 'toyota', name: '<img src=x onerror=alert(1)>' }));
  assert.throws(() => cleanBrand({ slug: 'toyota', name: 'Toyota', name_zh: '丰\n田' }));
  assert.equal(hasSlug([{ id: 1, slug: 'toyota' }], 'toyota'), true);
  assert.equal(hasSlug([{ id: 1, slug: 'toyota' }], 'toyota', 1), false);
});

test('brand normalization is compatible with missing or malformed legacy data', async () => {
  const { normalizeBrands, nextBrandId } = await brands;
  assert.equal(normalizeBrands(undefined).length >= 15, true);
  assert.deepEqual(normalizeBrands([]), []);
  const normalized = normalizeBrands([
    { id: 3, slug: 'ford', name: 'Ford', name_zh: '福特' },
    { id: 4, slug: 'bad slug', name: 'Not safe' },
  ]);
  assert.deepEqual(normalized, [{ id: 3, slug: 'ford', name: 'Ford', name_zh: '福特' }]);
  assert.equal(nextBrandId(normalized), 4);
});

test('brand logo is optional, HTTPS-only, and preserved when omitted on update', async () => {
  const { cleanBrand } = await brands;
  const current = { id: 1, slug: 'toyota', name: 'Toyota', name_zh: '丰田', logo: 'https://cdn.example.com/toyota.svg' };
  assert.equal(cleanBrand({ name: 'Toyota Motors' }, current).logo, current.logo);
  assert.equal(cleanBrand({ name: 'Toyota', logo: '' }, current).logo, undefined);
  assert.equal(cleanBrand({ slug: 'toyota', name: 'Toyota', logo: 'https://cdn.example.com/logo.png' }).logo, 'https://cdn.example.com/logo.png');
  assert.throws(() => cleanBrand({ slug: 'toyota', name: 'Toyota', logo: 'http://cdn.example.com/logo.png' }));
  assert.throws(() => cleanBrand({ slug: 'toyota', name: 'Toyota', logo: '//cdn.example.com/logo.png' }));
  assert.throws(() => cleanBrand({ slug: 'toyota', name: 'Toyota', logo: `https://cdn.example.com/${'a'.repeat(500)}` }));
});
