'use strict';

/**
 * Тесты выдачи заказа в интерфейсе администратора (19-й день практики).
 *
 * Проверяется:
 *   • окно подтверждения есть только на странице администратора;
 *   • окно построено на <dialog>, фокус ставится на безопасную кнопку «Отмена»;
 *   • кнопка «Выдать» появляется только у заказов «Готов к выдаче»;
 *   • сценарий вызывает API выдачи и обновляет список после выдачи;
 *   • при отказе сервера окно не закрывается и показывает причину.
 *
 * Запуск:  node tests/issueDialog.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';

const { renderOrdersContent } = require('../src/views/ordersPage');

const PUBLIC = path.join(__dirname, '..', 'public', 'js');
const ACTIONS_JS = fs.readFileSync(path.join(PUBLIC, 'orderActions.js'), 'utf8');
const API_JS = fs.readFileSync(path.join(PUBLIC, 'api.js'), 'utf8');

/** Минимальная модель DOM для функции построения ячейки «Действия». */
function fakeDocument() {
  const make = (tag) => ({
    tagName: tag.toUpperCase(),
    childNodes: [],
    attributes: {},
    className: '',
    textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(node) { this.childNodes.push(node); return node; },
  });
  return { createElement: make, addEventListener() {}, getElementById: () => null };
}

function loadActions() {
  const window = {};
  vm.runInNewContext(ACTIONS_JS, { window, document: fakeDocument() });
  return window.PVH_ORDER_ACTIONS;
}

const order = (status) => ({
  id: 1, trackNumber: 'PVZ190000001', status, client: { name: 'Иванов', email: 'i@mail.ru' },
  cell: status === 'В пути' ? null : { id: 1, cellNumber: 7 },
});

test('окно подтверждения есть у администратора и нет у клиента', () => {
  assert.ok(renderOrdersContent({ isAdmin: true }).includes('id="issue-dialog"'));
  assert.ok(!renderOrdersContent({ isAdmin: false }).includes('id="issue-dialog"'));
});

test('окно — элемент <dialog> с заголовком и описанием', () => {
  const html = renderOrdersContent({ isAdmin: true });
  assert.match(html, /<dialog class="modal" id="issue-dialog" aria-labelledby="issue-title" aria-describedby="issue-text">/);
  assert.ok(!html.includes('role="dialog"'), 'роль задаёт сам элемент dialog');
  assert.ok(html.includes('<form method="dialog">'), 'отмена закрывает окно без сценария');
});

test('фокус при открытии — на «Отмена», а не на «Выдать»', () => {
  const html = renderOrdersContent({ isAdmin: true });
  assert.match(html, /value="cancel" autofocus>Отмена</);
  assert.match(html, /id="issue-confirm">Выдать заказ</);
});

test('в окне видны ячейка, трек-номер, получатель и описание', () => {
  const html = renderOrdersContent({ isAdmin: true });
  for (const id of ['issue-cell', 'issue-track', 'issue-client', 'issue-description', 'issue-error']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
});

test('кнопка «Выдать» — только у заказа «Готов к выдаче»', () => {
  const actions = loadActions();

  const ready = actions(order('Готов к выдаче'));
  assert.equal(ready.childNodes[0].attributes['data-action'], 'issue');
  assert.equal(ready.childNodes[0].textContent, 'Выдать');
  assert.match(ready.childNodes[0].attributes['aria-label'], /PVZ190000001/);

  assert.ok(!actions(order('Выдан')).childNodes.some((node) => node.attributes['data-action'] === 'issue'));
  assert.ok(!actions(order('В пути')).childNodes.some((node) => node.attributes['data-action'] === 'issue'));
});

test('сценарий открывает окно через showModal и вызывает API выдачи', () => {
  assert.ok(ACTIONS_JS.includes('dialog.showModal()'));
  assert.ok(ACTIONS_JS.includes('window.PVH_API.issueOrder(order.id)'));
  assert.ok(API_JS.includes("'/orders/' + encodeURIComponent(id) + '/issue'"));
});

test('после выдачи список обновляется, при ошибке окно остаётся открытым', () => {
  assert.ok(ACTIONS_JS.includes("dialog.close('issued')"));
  assert.ok(ACTIONS_JS.includes('PVH_ORDERS.load({ silent: true })'));
  assert.ok(ACTIONS_JS.includes('errorBox.hidden = false'), 'причина отказа показывается в окне');
});

test('повторное нажатие во время выдачи невозможно', () => {
  assert.ok(ACTIONS_JS.includes('confirmButton.disabled = true'));
});

test('стили окна: подложка и запрет прокрутки страницы под окном', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'main.css'), 'utf8');
  assert.ok(css.includes('.modal::backdrop'));
  assert.ok(css.includes('.modal:modal { overscroll-behavior: contain; }'));
});
