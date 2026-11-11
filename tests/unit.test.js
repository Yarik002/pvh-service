'use strict';

/**
 * Модульные (Unit) тесты бизнес-логики (23-й день практики).
 *
 * Тесты собраны по трём темам задания дня и проверяют отдельные функции
 * без запуска веб-сервера:
 *   1. валидация данных — правила полей и схемы форм;
 *   2. назначение ячеек — алгоритм выбора первой свободной или указанной ячейки;
 *   3. смена статусов — жизненный цикл заказа и связанные с ним ячейки.
 *
 * Каждый тест готовит собственные данные в базе в оперативной памяти,
 * поэтому тесты не зависят друг от друга и от порядка запуска.
 *
 * Запуск:  npm run test:unit   (или node tests/unit.test.js)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { validate, required, length, emailPattern } = require('../src/validators/rules');
const { receiveOrderSchema, loginSchema, registerSchema } = require('../src/validators/schemas');
const cellAssignment = require('../src/services/cellAssignment');
const orderService = require('../src/services/orderService');
const userRepository = require('../src/repositories/userRepository');
const cellRepository = require('../src/repositories/cellRepository');

/** Пустая база: 5 ячеек и один клиент. */
function prepare(cells = 5) {
  runMigrations();
  const db = getDb();
  db.exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');
  const insert = db.prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  for (let number = 1; number <= cells; number += 1) insert.run(number);
  return userRepository.create({ name: 'Иванов Иван', email: 'ivanov@mail.ru', passwordHash: 'x', role: 'client', isConfirmed: true });
}

const occupy = (number) => getDb().prepare("UPDATE Storage_Cells SET status = 'Занята' WHERE cell_number = ?").run(number);
const status = (number) => cellRepository.findByNumber(number).status;

/** Проверяет отказ с HTTP-статусом и кодом. */
function rejects(fn, httpStatus, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, httpStatus, error.message);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

// ===========================================================================
//  1. Валидация данных
// ===========================================================================

test('валидация: обязательное поле — пробелы не считаются значением', () => {
  const rule = required('Имя');
  assert.equal(rule('   ').ok, false);
  assert.equal(rule('   ').code, 'REQUIRED');
  assert.deepEqual(rule('  Иван '), { ok: true, value: 'Иван' });
});

test('валидация: длина считается в символах, а не в байтах', () => {
  const rule = length({ min: 2, max: 5, label: 'Имя' });
  assert.equal(rule('Ёж').ok, true, 'два кириллических символа');
  assert.equal(rule('И').code, 'TOO_SHORT');
  assert.equal(rule('Иванов').code, 'TOO_LONG');
});

test('валидация: формат адреса почты и приведение к нижнему регистру', () => {
  const rule = emailPattern();
  assert.deepEqual(rule(' Ivanov@Mail.RU '), { ok: true, value: 'ivanov@mail.ru' });
  for (const bad of ['ivanov', 'ivanov@', '@mail.ru', 'iva..nov@mail.ru', 'ivanov@mail', 'ivanov@mail.r']) {
    assert.equal(rule(bad).ok, false, bad);
  }
});

test('валидация: трек-номер приводится к верхнему регистру', () => {
  const data = validate({ trackNumber: ' ra123456789by ', description: '' }, receiveOrderSchema);
  assert.equal(data.trackNumber, 'RA123456789BY');
  assert.equal(data.description, '');
});

test('валидация: недопустимые трек-номера отклоняются с сообщением у поля', () => {
  for (const bad of ['12345', 'RA 123456', 'РА123456789', '-RA12345', 'RA12345-', 'A'.repeat(41)]) {
    assert.throws(() => validate({ trackNumber: bad }, receiveOrderSchema), (error) => {
      assert.equal(error.status, 400);
      assert.ok(error.details.trackNumber, bad);
      return true;
    });
  }
});

test('валидация: описание посылки не длиннее 500 символов', () => {
  assert.doesNotThrow(() => validate({ trackNumber: 'PVZ000001', description: 'а'.repeat(500) }, receiveOrderSchema));
  assert.throws(() => validate({ trackNumber: 'PVZ000001', description: 'а'.repeat(501) }, receiveOrderSchema),
    (error) => Boolean(error.details.description));
});

test('валидация: схема регистрации сообщает обо всех ошибках сразу', () => {
  assert.throws(() => validate({ name: 'И', email: 'нет', password: '1' }, registerSchema), (error) => {
    for (const field of ['name', 'email', 'password']) assert.ok(error.details[field], field);
    return true;
  });
});

test('валидация: на форме входа логин admin заменяется адресом администратора', () => {
  const data = validate({ email: ' ADMIN ', password: 'admin' }, loginSchema);
  assert.equal(data.email, 'admin@pvh.local');
  assert.equal(validate({ email: 'Ivanov@mail.ru', password: 'x' }, loginSchema).email, 'ivanov@mail.ru');
});

test('валидация: параметры списка заказов проверяются по белому списку', () => {
  assert.deepEqual(orderService.parseListQuery({ status: 'READY', sort: 'cell', order: 'ASC' }),
    { status: 'Готов к выдаче', search: '', sort: 'cell', order: 'asc' });
  rejects(() => orderService.parseListQuery({ sort: 'password_hash' }), 400, 'BAD_FILTER');
  rejects(() => orderService.parseListQuery({ sort: 'client' }), 400, 'BAD_FILTER');
});

// ===========================================================================
//  2. Назначение ячеек
// ===========================================================================

test('ячейки: автоматически выбирается свободная ячейка с наименьшим номером', () => {
  prepare();
  occupy(1);
  occupy(2);
  occupy(4);
  const choice = cellAssignment.chooseCell({ mode: 'auto' });
  assert.equal(choice.mode, 'auto');
  assert.equal(choice.cell.cellNumber, 3);
  assert.equal(status(3), 'Свободна', 'выбор ячейку не занимает');
});

test('ячейки: если свободных нет — понятный отказ 409 NO_FREE_CELLS', () => {
  prepare(3);
  [1, 2, 3].forEach(occupy);
  rejects(() => cellAssignment.chooseCell({ mode: 'auto' }), 409, 'NO_FREE_CELLS');
});

test('ячейки: ручной выбор по номеру и по идентификатору', () => {
  prepare();
  assert.equal(cellAssignment.chooseCell({ mode: 'manual', cellNumber: 4 }).cell.cellNumber, 4);
  const id = cellRepository.findByNumber(5).id;
  assert.equal(cellAssignment.chooseCell({ mode: 'manual', cellId: String(id) }).cell.cellNumber, 5);
});

test('ячейки: ручной выбор занятой, несуществующей или неуказанной ячейки', () => {
  prepare();
  occupy(2);
  rejects(() => cellAssignment.chooseCell({ mode: 'manual', cellNumber: 2 }), 409, 'CELL_BUSY');
  rejects(() => cellAssignment.chooseCell({ mode: 'manual', cellNumber: 99 }), 404, 'CELL_NOT_FOUND');
  rejects(() => cellAssignment.chooseCell({ mode: 'manual' }), 400, 'CELL_REQUIRED');
  rejects(() => cellAssignment.chooseCell({ mode: 'manual', cellNumber: '2.5' }), 400, 'INVALID_CELL');
  rejects(() => cellAssignment.chooseCell({ mode: 'случайно' }), 400, 'INVALID_ASSIGN_MODE');
});

test('ячейки: assignCell занимает ячейку, повторное занятие невозможно', () => {
  prepare();
  const result = cellAssignment.assignCell({ mode: 'auto' });
  assert.equal(result.cell.cellNumber, 1);
  assert.equal(status(1), 'Занята');
  rejects(() => cellAssignment.occupyCell(result.cell.id), 409, 'CELL_BUSY');
});

test('ячейки: подряд назначаются разные ячейки', () => {
  prepare();
  const numbers = [1, 2, 3].map(() => cellAssignment.assignCell({ mode: 'auto' }).cell.cellNumber);
  assert.deepEqual(numbers, [1, 2, 3]);
});

// ===========================================================================
//  3. Смена статусов
// ===========================================================================

test('статусы: разрешены только переходы по жизненному циклу', () => {
  const { canChangeStatus } = orderService;
  assert.equal(canChangeStatus('В пути', 'Готов к выдаче'), true);
  assert.equal(canChangeStatus('Готов к выдаче', 'Выдан'), true);
  assert.equal(canChangeStatus('В пути', 'Выдан'), false, 'нельзя выдать непринятый заказ');
  assert.equal(canChangeStatus('Выдан', 'Готов к выдаче'), false, 'обратного хода нет');
  assert.equal(canChangeStatus('Готов к выдаче', 'В пути'), false);
  assert.equal(canChangeStatus('Потерян', 'Выдан'), false);
});

test('статусы: таблица переходов защищена от изменения', () => {
  assert.ok(Object.isFrozen(orderService.STATUS_TRANSITIONS));
  assert.ok(Object.isFrozen(orderService.STATUS_TRANSITIONS['В пути']));
});

test('статусы: приёмка — «Готов к выдаче», ячейка занята, дата поступления', async () => {
  prepare();
  const { order } = await orderService.receiveOrder({ trackNumber: 'PVZ230000001', clientEmail: 'ivanov@mail.ru' });
  assert.equal(order.status, 'Готов к выдаче');
  assert.ok(order.receivedAt);
  assert.equal(order.issuedAt, null);
  assert.equal(status(order.cell.cellNumber), 'Занята');
});

test('статусы: «В пути» → «Готов к выдаче» при приёмке ожидаемого заказа', async () => {
  prepare();
  orderService.createExpectedOrder({ trackNumber: 'PVZ230000002', clientEmail: 'ivanov@mail.ru' });
  const result = await orderService.receiveOrder({ trackNumber: 'PVZ230000002', clientEmail: 'ivanov@mail.ru' });
  assert.equal(result.fromTransit, true);
  assert.equal(result.order.status, 'Готов к выдаче');
});

test('статусы: выдача — «Выдан», дата выдачи, ячейка свободна', async () => {
  prepare();
  const { order } = await orderService.receiveOrder({ trackNumber: 'PVZ230000003', clientEmail: 'ivanov@mail.ru' });
  const result = orderService.issueOrder(order.id);
  assert.equal(result.order.status, 'Выдан');
  assert.ok(result.order.issuedAt);
  assert.equal(status(order.cell.cellNumber), 'Свободна');
});

test('статусы: недопустимые переходы отклоняются, база не меняется', async () => {
  const client = prepare();
  const transitId = getDb().prepare("INSERT INTO Orders (track_number, user_id) VALUES ('PVZ230000004', ?)").run(client.id).lastInsertRowid;
  rejects(() => orderService.issueOrder(transitId), 409, 'ORDER_NOT_READY');

  const { order } = await orderService.receiveOrder({ trackNumber: 'PVZ230000005', clientEmail: 'ivanov@mail.ru' });
  orderService.issueOrder(order.id);
  rejects(() => orderService.issueOrder(order.id), 409, 'ORDER_ALREADY_ISSUED');
  rejects(() => orderService.updateOrder(order.id, { description: 'x' }), 409, 'ORDER_READONLY');
  await assert.rejects(orderService.receiveOrder({ trackNumber: 'PVZ230000005', clientEmail: 'ivanov@mail.ru' }),
    { status: 409, code: 'TRACK_EXISTS' });
});

test('статусы: база данных сама запрещает «Выдан» без даты выдачи', () => {
  const client = prepare();
  assert.throws(() => getDb().prepare("INSERT INTO Orders (track_number, user_id, status) VALUES ('PVZ230000006', ?, 'Выдан')")
    .run(client.id), /CHECK constraint failed/);
});

test('статусы: в одной ячейке не может лежать два заказа «Готов к выдаче»', () => {
  const client = prepare();
  const cellId = cellRepository.findByNumber(1).id;
  const insert = getDb().prepare(`INSERT INTO Orders (track_number, user_id, cell_id, status, received_at)
                                  VALUES (?, ?, ?, 'Готов к выдаче', datetime('now'))`);
  insert.run('PVZ230000007', client.id, cellId);
  assert.throws(() => insert.run('PVZ230000008', client.id, cellId), /UNIQUE constraint failed/);
});

test.after(() => closeDb());
