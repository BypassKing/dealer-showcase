const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
const fixture = [
  { id: 1, brand: 'Toyota', year: 2022, status: 'Available' },
  { id: 2, brand: '丰田', year: 2021, status: 'Available' },
  { id: 3, brand: 'BMW', year: 2020, status: 'Available' },
];
const catalog = [
  { id: 1, slug: 'toyota', name: 'Toyota', name_zh: '丰田', logo: 'https://cdn.example.test/toyota.svg' },
  { id: 2, slug: 'bmw', name: 'BMW', name_zh: '宝马' },
];

function fakeNode(initial = {}) {
  const listeners = {};
  const attributes = {};
  const classes = new Set(initial.classes || []);
  return {
    ...initial,
    value: initial.value || '',
    hidden: Boolean(initial.hidden),
    dataset: initial.dataset || {},
    listeners,
    attributes,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
    },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    dispatch(type, event = {}) {
      const e = { target: this, key: '', preventDefault() {}, ...event };
      for (const listener of listeners[type] || []) listener(e);
      this[`on${type}`]?.(e);
    },
    focus() { this.focused = true; },
    querySelector(selector) { return this.options?.find(option => selector === 'option[value="PHEV"]' && option.value === 'PHEV') || this.child || null; },
    appendChild(child) { (this.options ||= []).push(child); this.child ||= child; },
    closest(selector) { return initial.closest?.(selector) || null; },
  };
}

function harness() {
  const close = fakeNode();
  const backdrop = fakeNode();
  const nodes = {
    '#brand': fakeNode(),
    '#brandFilterToggle': fakeNode({ attributes: { 'aria-expanded': 'false' } }),
    '#brandFilterLabel': fakeNode(),
    '#brandFilterPanel': fakeNode({ hidden: true, child: close }),
    '#brandFilterClose': close,
    '#cargrid': fakeNode(),
    '#carCount': fakeNode(),
    '#q': fakeNode(),
    '#status': fakeNode(),
    '#bodyType': fakeNode(),
    '#fuelType': fakeNode(),
    '#priceRange': fakeNode(),
    '#yearFilter': fakeNode(),
    '#sort': fakeNode({ value: 'newest' }),
  };
  nodes['#brandFilterPanel'].style = { setProperty() {} };
  nodes['#brandFilterPanel'].querySelectorAll = () => [close, backdrop];
  const originalQuerySelector = nodes['#brandFilterPanel'].querySelector;
  nodes['#brandFilterPanel'].querySelector = selector => selector === '.brand-filter-close' ? close : originalQuerySelector(selector);
  const brandButtons = [];
  const listeners = {};
  const document = {
    activeElement: null,
    querySelector: selector => nodes[selector],
    querySelectorAll: selector => selector === '[data-brand-filter]' ? brandButtons : [],
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    createElement: tagName => ({ tagName, value: '', textContent: '' }),
    body: fakeNode(),
  };
  const context = vm.createContext({
    document,
    window: {
      AUTOHAVEN_BRAND_NAMES: {
        toyota: { name: 'Toyota', name_zh: '丰田' },
        bmw: { name: 'BMW', name_zh: '宝马' },
      },
      AUTOHAVEN_BRAND_LOGOS: { toyota: '/brand-logos/toyota.svg' },
      addEventListener() {},
    },
    localStorage: { getItem: () => '' },
    fetch: () => new Promise(() => {}),
    NodeFilter: { SHOW_TEXT: 4 },
    fixture,
    catalog,
  });
  vm.runInContext(source, context);
  vm.runInContext("vehicles=fixture;language='en';card=v=>'<i data-id=\"'+v.id+'\"></i>';api=async url=>url==='/api/vehicles'?fixture:catalog", context);
  return { context, nodes, brandButtons, listeners, run: code => vm.runInContext(code, context) };
}

test('brand filter starts collapsed and keeps a translated button label', () => {
  const h = harness();
  h.run('vehicles=fixture;language="zh"');
  return h.run('cars()').then(html => {
    assert.match(html, /id="brandFilterToggle"[^>]*aria-expanded="false"/);
    assert.match(html, /id="brandFilterPanel"[^>]*aria-hidden="true"[^>]*hidden/);
    assert.match(html, /丰田/);
    assert.match(html, /Toyota/);
  });
});

test('brand aliases match English and Chinese vehicle records in either locale', () => {
  const h = harness();
  h.run('vehicles=fixture;brandFilterSection(catalog)');
  for (const language of ['en', 'zh']) {
    h.run(`language=${JSON.stringify(language)}`);
    for (const selected of ['Toyota', '丰田', 'toyota']) {
      h.run(`document.querySelector('#brand').value=${JSON.stringify(selected)};filterCars()`);
      const ids = [...h.nodes['#cargrid'].innerHTML.matchAll(/data-id="(\d+)"/g)].map(match => Number(match[1]));
      assert.deepEqual(ids.sort(), [1, 2], `${language} selection ${selected}`);
    }
  }
});

test('known Mercedes and Land Rover spelling variants share one filter entry', () => {
  const h = harness();
  h.run('vehicles=[]');
  const catalog = h.run(`buildBrandCatalog([
    { slug: 'mercedes-benz', name: 'Mercedes-Benz', name_zh: '奔驰' },
    { slug: 'mercedes-benz-alt', name: 'Mercedes Benz', name_zh: '奔驰' },
    { slug: 'land-rover', name: 'Land Rover', name_zh: '路虎' },
    { slug: 'landrover', name: 'Land-Rover', name_zh: '路虎' },
    { slug: 'alpha-motors', name: 'Alpha Motors', name_zh: '同名译名' },
    { slug: 'beta-motors', name: 'Beta Motors', name_zh: '同名译名' }
  ])`);
  assert.equal(catalog.length, 4);
  assert.ok(catalog.some(brand => brand.name === 'Alpha Motors'));
  assert.ok(catalog.some(brand => brand.name === 'Beta Motors'));
  h.run(`vehicles=[
    {id:1,brand:'Mercedes Benz',status:'Available'},
    {id:2,brand:'MERCEDESBENZ',status:'Available'},
    {id:3,brand:'Land-Rover',status:'Available'},
    {id:4,brand:'Land Rover',status:'Available'}
  ];publicBrandCatalog=buildBrandCatalog(${JSON.stringify(catalog)})`);
  for (const selected of ['mercedes-benz', 'land-rover']) {
    h.nodes['#brand'].value = selected;
    h.run('filterCars()');
    const ids = [...h.nodes['#cargrid'].innerHTML.matchAll(/data-id="(\d+)"/g)].map(match => Number(match[1]));
    assert.deepEqual(ids.sort(), selected === 'mercedes-benz' ? [1, 2] : [3, 4]);
  }
});

test('inventory controls use four desktop columns and a two-by-two mobile layout', () => {
  assert.match(styles, /\.inventory-page \.mobile-filter-bar\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/);
  assert.match(styles, /@media\(max-width:680px\)\{\.inventory-page \.mobile-filter-bar\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(styles, /\.inventory-page \.mobile-filter-bar\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
});

test('brand sheet shrinks to content while list scrolls and close footer stays fixed', () => {
  assert.match(styles, /\.brand-filter-sheet\{[^}]*height:auto;max-height:min\(68vh,690px,calc\(100% - 12px\)\)/);
  assert.match(styles, /\.brand-filter-grid\{[^}]*overflow:auto/);
  assert.match(styles, /\.brand-filter-footer\{[^}]*flex:none/);
  assert.match(styles, /max-height:min\(67vh,640px,calc\(100% - 6px\)\)/);
});

test('brand badge count includes each English and Chinese alias record once', () => {
  const h = harness();
  h.run('vehicles=fixture;language="en"');
  const html = h.run('brandFilterSection(catalog)');
  const toyotaTile = html.match(/<button[^>]*data-brand-filter="[^"]+"[^>]*>[\s\S]*?<span class="brand-filter-name">Toyota<\/span>[\s\S]*?<span class="brand-filter-count">(\d+)<\/span>/);
  assert.ok(toyotaTile, 'Toyota brand tile should be rendered');
  assert.equal(toyotaTile[1], '2');
});

test('built-in logo uses the local same-origin asset', () => {
  const h = harness();
  h.run('vehicles=fixture;language="en"');
  const html = h.run('brandFilterSection(catalog.map(brand=>({...brand,logo:""})))');
  assert.match(html, /src="\/brand-logos\/toyota\.svg"/);
});

test('brand panel opens, then selection, close button, backdrop and Escape close it', () => {
  const h = harness();
  const toggle = h.nodes['#brandFilterToggle'];
  const popover = h.nodes['#brandFilterPanel'];
  const close = h.nodes['#brandFilterClose'];
  const backdrop = popover.querySelectorAll()[1];
  const brandButton = fakeNode({ dataset: { brandFilter: 'toyota' } });
  h.brandButtons.push(brandButton);
  h.run('vehicles=fixture;brandFilterSection(catalog)');
  h.run('initBrandFilter()');

  toggle.dispatch('click');
  assert.equal(popover.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  brandButton.dispatch('click');
  assert.equal(h.nodes['#brand'].value, 'toyota');
  assert.equal(popover.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  toggle.dispatch('click');
  close.dispatch('click');
  assert.equal(popover.hidden, true);
  toggle.dispatch('click');
  for (const listener of h.listeners.keydown || []) listener({ key: 'Escape', preventDefault() {} });
  popover.dispatch('keydown', { key: 'Escape' });
  assert.equal(popover.hidden, true);
  toggle.dispatch('click');
  backdrop.dispatch('click');
  assert.equal(popover.hidden, true);
});

test('failed brand logos expose the initial fallback', () => {
  const h = harness();
  const fallback = fakeNode();
  const icon = fakeNode();
  const image = fakeNode({ hidden: false, parentElement: icon, closest: selector => selector === '[data-brand-logo]' ? image : null });
  const errorListeners = h.listeners.error || [];
  assert.ok(errorListeners.length);
  for (const listener of errorListeners) listener({ target: image });
  assert.equal(image.hidden, true);
  assert.equal(icon.classList.contains('has-fallback'), true);
});
