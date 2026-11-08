const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const fixture = [
  { id: 1, fuelType: 'PHEV' },
  { id: 2, fuel: 'PHEV' },
  { id: 3, fuelType: 'Hybrid' },
];

function harness() {
  const nodes = Object.fromEntries(['q', 'status', 'brand', 'bodyType', 'fuelType', 'priceRange', 'yearFilter', 'sort', 'cargrid', 'carCount'].map(id => ['#' + id, { value: '', innerHTML: '', textContent: '' }]));
  const listeners = {};
  const context = vm.createContext({
    document: {
      querySelector: selector => nodes[selector],
      addEventListener: (type, listener) => (listeners[type] ||= []).push(listener),
      createElement: tagName => ({ tagName, value: '', textContent: '' }),
    },
    window: { addEventListener() {} },
    localStorage: { getItem: () => '' },
    fetch: () => new Promise(() => {}),
    fixture,
  });
  vm.runInContext(source, context);
  vm.runInContext("vehicles=fixture;language='en';card=v=>'<i data-id=\"'+v.id+'\"></i>';api=async()=>fixture", context);
  return {
    context,
    nodes,
    run: code => vm.runInContext(code, context),
    ids: () => [...nodes['#cargrid'].innerHTML.matchAll(/data-id="(\d+)"/g)].map(match => Number(match[1])),
  };
}

function fakeSelect() {
  const options = [];
  return {
    options,
    value: '',
    querySelector: selector => selector === 'option[value="PHEV"]' ? options.find(option => option.value === 'PHEV') || null : null,
    appendChild: option => options.push(option),
  };
}

test('PHEV is added as a localized fuel filter option and is not duplicated', () => {
  const h = harness();
  const select = fakeSelect();
  h.nodes['#fuelType'] = select;
  h.context.select = select;
  h.run('initBrandFilter()');
  h.run('addPhevFuelOption(select)');
  h.run('addPhevFuelOption(select)');
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, 'PHEV');
  assert.equal(select.options[0].textContent, 'Plug-in hybrid (PHEV)');
});

test('PHEV label is translated in all eight supported languages', () => {
  const h = harness();
  const labels = {
    en: 'Plug-in hybrid (PHEV)',
    zh: 'PHEV（插电式混合动力）',
    id: 'Hibrida plug-in (PHEV)',
    th: 'ปลั๊กอินไฮบริด (PHEV)',
    ms: 'Hibrid plug-in (PHEV)',
    fil: 'Plug-in hybrid (PHEV)',
    vi: 'Hybrid sạc điện (PHEV)',
    ha: 'Hybrid mai shigar da wuta (PHEV)',
  };
  for (const [language, label] of Object.entries(labels)) {
    h.run(`language=${JSON.stringify(language)}`);
    assert.equal(h.run("vehicleTerm('PHEV')"), label, language);
  }
});

test('PHEV fuel filter matches current and legacy fuel fields only', () => {
  const h = harness();
  h.nodes['#fuelType'].value = 'PHEV';
  h.run('filterCars()');
  assert.deepEqual(h.ids(), [2, 1]);
  assert.equal(h.nodes['#carCount'].textContent, '2');
});

test('editing a PHEV vehicle adds and selects the fuel option', () => {
  const h = harness();
  const select = fakeSelect();
  h.context.form = { dataset: { editId: '1' }, elements: { fuelType: select } };
  h.run('upgradePhevFuelField(form)');
  assert.equal(select.value, 'PHEV');
  assert.equal(select.options[0].textContent, 'PHEV（插电式混合动力）');
});
