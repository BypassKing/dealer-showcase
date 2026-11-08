const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Optional browser regression suite. Uses an already installed browser and
// Playwright package; all page/API requests are mocked, with no real server.
const { chromium } = require(process.env.DEALER_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.join(__dirname, '..');

test('brand create/edit dialogs match vehicle dialogs on desktop and mobile', async t => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.DEALER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.DEALER_BROWSER_EXECUTABLE }
      : { channel: 'msedge' }),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = {
    brands: [{ id: 1, name: 'Toyota', name_zh: '丰田', slug: 'toyota' }],
    writes: [], rejectNext: '',
  };
  const assets = new Map([
    ['/', ['public/index.html', 'text/html']],
    ['/app.js', ['public/app.js', 'text/javascript']],
    ['/style.css', ['public/style.css', 'text/css']],
    ['/brand-logos.js', ['public/brand-logos.js', 'text/javascript']],
  ]);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    if (url.hostname !== 'dealer-ui.test') return route.abort();
    if (assets.has(pathname)) {
      const [filename, contentType] = assets.get(pathname);
      return route.fulfill({ contentType, body: fs.readFileSync(path.join(root, filename)) });
    }
    let body;
    if (pathname === '/api/locale') body = { language: 'zh' };
    else if (pathname === '/api/admin/session') body = { authenticated: true, admin: { id: 'qa', name: '测试管理员', username: 'admin', role: 'superadmin' } };
    else if (pathname === '/api/vehicles') body = [{ id: 42, title: '测试车辆', title_zh: '测试车辆', year: '2022', brand: 'Toyota', image: '', images: [], status: 'Available' }];
    else if (pathname === '/api/contacts' || pathname === '/api/sales-links') body = [];
    else if (pathname === '/api/brands' && request.method() === 'GET') body = state.brands;
    else if (/^\/api\/brands(?:\/\d+)?$/.test(pathname)) {
      const data = request.postDataJSON();
      state.writes.push({ method: request.method(), pathname, data });
      if (state.rejectNext) {
        const error = state.rejectNext;
        state.rejectNext = '';
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error }) });
      }
      if (request.method() === 'POST') state.brands.push({ id: 2, ...data });
      else state.brands = state.brands.map(brand => String(brand.id) === pathname.split('/').pop() ? { ...brand, ...data } : brand);
      body = { ok: true };
    } else return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('https://dealer-ui.test/#/admin');
  await page.locator('[data-tab="brands"]').click();
  const dialog = page.locator('dialog.brand-edit-dialog[open]');
  const form = page.locator('#brandEditor');
  const input = name => form.locator(`[name="${name}"]`);
  const save = () => form.locator('button[type="submit"]').click();

  await t.test('create opens a modal with two desktop columns and saves through the existing brand API', async () => {
    await page.locator('#addBrand').click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getAttribute('aria-labelledby'), 'brandEditDialogTitle');
    assert.equal(await page.locator('#brandEditDialogTitle').textContent(), '添加车辆品牌');
    assert.equal(await page.locator('#brandForm form').count(), 0, 'the editor must not remain underneath the table');
    assert.equal(await input('name').evaluate(element => document.activeElement === element), true);
    assert.ok((await dialog.boundingBox()).height < 650, 'a short brand form must not stretch into a full-height blank dialog');
    const english = await input('name').boundingBox(), chinese = await input('name_zh').boundingBox();
    assert.ok(Math.abs(english.y - chinese.y) < 2 && chinese.x > english.x);
    await input('name').fill('Test Motors');
    await input('name_zh').fill('测试品牌');
    await input('slug').fill('test-motors');
    const screenshot = path.join(os.tmpdir(), 'dealer-brand-editor-desktop.png');
    await page.screenshot({ path: screenshot });
    console.log(`Desktop screenshot: ${screenshot}`);
    await save();
    await dialog.waitFor({ state: 'detached' });
    assert.match(await page.locator('.brand-admin-table').textContent(), /Test Motors.*测试品牌/s);
    assert.equal(state.writes.at(-1).method, 'POST');
    assert.equal(state.writes.at(-1).data.slug, 'test-motors');
  });

  await t.test('edit prefills every field, persists, and shows saved values when reopened', async () => {
    await page.locator('[data-edit-brand="1"]').click();
    assert.equal(await page.locator('#brandEditDialogTitle').textContent(), '编辑车辆品牌');
    assert.equal(await input('name').inputValue(), 'Toyota');
    assert.equal(await input('name_zh').inputValue(), '丰田');
    assert.equal(await input('slug').inputValue(), 'toyota');
    assert.equal(await input('logo').inputValue(), '');
    await input('name_zh').fill('丰田汽车');
    await input('logo').fill('https://example.test/toyota.svg');
    await save();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(state.writes.at(-1).method, 'PUT');
    assert.equal(state.writes.at(-1).pathname, '/api/brands/1');
    await page.locator('[data-edit-brand="1"]').click();
    assert.equal(await input('name_zh').inputValue(), '丰田汽车');
    assert.equal(await input('logo').inputValue(), 'https://example.test/toyota.svg');
    await form.locator('[data-cancel-brand]').click();
  });

  await t.test('failed saves preserve form values and allow correction inside the modal', async () => {
    await page.locator('[data-edit-brand="1"]').click();
    await input('name_zh').fill('修改未保存');
    state.rejectNext = '品牌标识已存在';
    await save();
    await page.locator('#brandSaveResult').filter({ hasText: '品牌标识已存在' }).waitFor();
    assert.equal(await dialog.count(), 1);
    assert.equal(await input('name_zh').inputValue(), '修改未保存');
    assert.equal(await form.locator('button[type="submit"]').isEnabled(), true);
    await form.locator('[data-cancel-brand]').click();
    assert.equal(state.brands[0].name_zh, '丰田汽车');
  });

  await t.test('cancel, close, Escape and backdrop dismiss without saving and restore keyboard focus', async () => {
    const before = state.writes.length;
    for (const action of ['cancel', 'close', 'escape', 'backdrop']) {
      await page.locator('#addBrand').click();
      await dialog.waitFor({ state: 'visible' });
      await input('name').fill('Unsaved');
      if (action === 'cancel') await form.locator('[data-cancel-brand]').click();
      else if (action === 'close') await dialog.locator('[data-close-vehicle-edit]').click();
      else if (action === 'escape') await page.keyboard.press('Escape');
      else await page.mouse.click(2, 2);
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await page.locator('#addBrand').evaluate(element => document.activeElement === element), true);
    }
    assert.equal(state.writes.length, before);
    await page.locator('#addBrand').click();
    assert.equal(await input('name').inputValue(), '');
    await form.locator('[data-cancel-brand]').click();
  });

  await t.test('mobile and short landscape dialogs fit the viewport with an accessible sticky footer', async () => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#addBrand').click();
      await dialog.waitFor({ state: 'visible' });
      const rect = await dialog.boundingBox();
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, JSON.stringify({ viewport, rect }));
      const overflow = await dialog.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
      const footer = await form.locator('.editor-actions').boundingBox();
      assert.ok(footer.y >= rect.y && footer.y + footer.height <= viewport.height + 1, JSON.stringify(footer));
      if (viewport.width < 680) {
        const english = await input('name').boundingBox(), chinese = await input('name_zh').boundingBox();
        assert.ok(chinese.y > english.y && Math.abs(chinese.x - english.x) < 2);
        assert.equal(await input('name').evaluate(element => getComputedStyle(element).fontSize), '16px');
      }
      if (viewport.width === 390) {
        const screenshot = path.join(os.tmpdir(), 'dealer-brand-editor-mobile.png');
        await page.screenshot({ path: screenshot });
        console.log(`Mobile screenshot: ${screenshot}`);
      }
      await form.locator('[data-cancel-brand]').click();
    }
  });

  await t.test('the shared dialog helper keeps vehicle creation and editing unchanged', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('[data-tab="vehicles"]').click();
    await page.locator('#addVehicle').click();
    const vehicleDialog = page.locator('dialog.vehicle-edit-dialog[open]');
    await vehicleDialog.waitFor({ state: 'visible' });
    assert.equal(await vehicleDialog.getAttribute('aria-labelledby'), 'vehicleEditDialogTitle');
    assert.equal(await vehicleDialog.getAttribute('class'), 'vehicle-edit-dialog');
    assert.equal(await page.locator('#vehicleEditDialogTitle').textContent(), '添加车辆资料');
    await vehicleDialog.locator('[data-close-vehicle-edit]').click();
    await page.locator('[data-edit-v="42"]').click();
    await vehicleDialog.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#vehicleEditDialogTitle').textContent(), '编辑车辆资料');
    assert.equal(await page.locator('#vf [name="title_zh"]').inputValue(), '测试车辆');
    await page.keyboard.press('Escape');
    await vehicleDialog.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  });
});
