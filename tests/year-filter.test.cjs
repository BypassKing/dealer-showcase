const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const fixture = [
  { id: 1, year: 2019, brand: 'Toyota', price: '$24,800', mileage: '32,400 mi', fuelType: 'Petrol', bodyType: 'Sedan', status: 'Available' },
  { id: 2, year: '2025', brand: 'Toyota', price: '8,000', mileage: 6000, fuelType: 'Hybrid', bodyType: 'SUV', status: 'Available' },
  { id: 3, year: ' 2025 ', brand: 'BMW', price: 18000, mileage: 2000, fuelType: 'Diesel', bodyType: 'SUV', status: 'Reserved' },
  { id: 4, year: '2020年', brand: 'Geely', price: 4455.1 },
  { id: 5, year: 2027, brand: 'Toyota', price: 30000 },
  { id: 6, year: '', price: 1000 },
  { id: 7, year: '20abc24', price: 2000 },
];

function harness(currentYear = 2026) {
  const nodes = Object.fromEntries(['q', 'status', 'brand', 'bodyType', 'fuelType', 'priceRange', 'yearFilter', 'sort', 'cargrid', 'carCount'].map(id => ['#' + id, { value: '', innerHTML: '', textContent: '' }]));
  const listeners = {};
  const context = vm.createContext({
    Date: class extends Date { getFullYear() { return currentYear; } },
    document: { querySelector: selector => nodes[selector], addEventListener: (type, listener) => (listeners[type] ||= []).push(listener) },
    window: { addEventListener() {} },
    localStorage: { getItem: () => '' },
    fetch: () => new Promise(() => {}),
    fixture,
  });
  vm.runInContext(source, context);
  vm.runInContext("vehicles=fixture;language='en';card=v=>'<i data-id=\"'+v.id+'\"></i>';api=async()=>fixture", context);
  return { context, nodes, listeners, run: code => vm.runInContext(code, context), ids: () => [...nodes['#cargrid'].innerHTML.matchAll(/data-id="(\d+)"/g)].map(match => Number(match[1])) };
}

test('year normalization accepts numbers, spaces and Chinese suffix without coercing invalid values', () => {
  const h = harness();
  for (const [value, expected] of [[2019, '2019'], [' 2025 ', '2025'], ['2020年', '2020'], [2027, '2027'], [null, ''], ['', ''], ['0000', ''], ['20abc24', ''], ['2020.5', ''], ['2020/2021', ''], ['<img src=x onerror=alert(1)>', '']]) {
    h.context.input = value;
    assert.equal(h.run('normalizeVehicleYear(input)'), expected);
  }
});

test('year options cover 2015 through the current year, newest first, in all eight languages', async () => {
  const h = harness();
  const labels = { en: 'All years', zh: '不限年份', id: 'Semua tahun', th: 'ทุกปี', ms: 'Semua tahun', fil: 'Lahat ng taon', vi: 'Tất cả các năm', ha: 'Duk shekaru' };
  h.nodes['#brand'].value = 'BMW';
  for (const [language, label] of Object.entries(labels)) {
    h.run(`language=${JSON.stringify(language)}`);
    const html = await h.run('cars()');
    const yearSelect = html.match(/<select id="yearFilter"[^>]*>([\s\S]*?)<\/select>/)[1];
    assert.ok(yearSelect.includes(`<option value="">${label}</option>`), language);
    assert.deepEqual([...yearSelect.matchAll(/<option value="(\d{4})">/g)].map(match => match[1]), Array.from({ length: 12 }, (_, index) => String(2026 - index)));
    assert.ok(!yearSelect.includes('value="2014"'));
    assert.ok(!yearSelect.includes('value="2027"'));
    assert.ok(!yearSelect.includes('undefined'));
    for (const key of ['year', 'allYears', 'noVehicles']) assert.ok(h.run(`filterText[language][${JSON.stringify(key)}]`));
  }
});

test('year options advance automatically and remain available with an empty inventory', async () => {
  for (const currentYear of [2025, 2026, 2027]) {
    const h = harness(currentYear);
    h.run('api=async()=>[]');
    const html = await h.run('cars()');
    const yearSelect = html.match(/<select id="yearFilter"[^>]*>([\s\S]*?)<\/select>/)[1];
    const years = [...yearSelect.matchAll(/<option value="(\d{4})">/g)].map(match => match[1]);
    assert.deepEqual(years, Array.from({ length: currentYear - 2014 }, (_, index) => String(currentYear - index)));
  }
});

test('year matching is exact, handles historical formats and all-years restores every record', () => {
  const h = harness();
  h.nodes['#yearFilter'].value = '2025';
  h.run('filterCars()');
  assert.deepEqual(h.ids(), [3, 2]);
  assert.equal(h.nodes['#carCount'].textContent, '2');
  h.nodes['#yearFilter'].value = '2020';
  h.run('filterCars()');
  assert.deepEqual(h.ids(), [4]);
  h.nodes['#yearFilter'].value = '';
  h.run('filterCars()');
  assert.deepEqual(h.ids(), [7, 6, 5, 4, 3, 2, 1]);
});

test('year combines with search, brand, price, body, fuel, status and sorting', () => {
  const h = harness();
  const values = { yearFilter: '2025', q: 'toyota', brand: 'Toyota', priceRange: '0-10000', bodyType: 'SUV', fuelType: 'Hybrid', status: 'Available', sort: 'price-low' };
  for (const [id, value] of Object.entries(values)) h.nodes['#' + id].value = value;
  h.run('filterCars()');
  assert.deepEqual(h.ids(), [2]);
  h.nodes['#yearFilter'].value = '2019';
  h.run('filterCars()');
  assert.deepEqual(h.ids(), []);
  assert.equal(h.nodes['#carCount'].textContent, '0');
});

test('price and mileage sorting still understand formatted historical numbers', () => {
  const h = harness();
  h.nodes['#brand'].value = 'Toyota';
  h.nodes['#sort'].value = 'price-low';
  h.run('filterCars()');
  assert.deepEqual(h.ids(), [2, 1, 5]);
  h.nodes['#sort'].value = 'mileage-low';
  h.run('filterCars()');
  assert.deepEqual(h.ids(), [2, 1, 5]);
});

test('changing year triggers filtering and empty results stay localized', () => {
  const h = harness();
  h.nodes['#yearFilter'].value = '2019';
  const event = { target: { matches: selector => selector.split(',').includes('#yearFilter') } };
  h.listeners.change.forEach(listener => listener(event));
  assert.deepEqual(h.ids(), [1]);
  h.nodes['#yearFilter'].value = '1990';
  for (const language of ['en', 'zh', 'id', 'th', 'ms', 'fil', 'vi', 'ha']) {
    h.run(`language=${JSON.stringify(language)};filterCars()`);
    assert.equal(h.nodes['#cargrid'].innerHTML, `<div class="empty">${h.run("ft('noVehicles')")}</div>`);
  }
});
