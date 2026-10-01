'use strict';

/**
 * Модульные тесты ролевой модели и управления ячейками (8-й день практики).
 *
 * Запуск:  node tests/roles.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const authService = require('../src/services/authService');
const confirmationService = require('../src/services/confirmationService');
const cellService = require('../src/services/cellService');
const userRepository = require('../src/repositories/userRepository');
const cellRepository = require('../src/repositories/cellRepository');
const AppError = require('../src/utils/AppError');

const PASSWORD = 'Xk9#mQ2$vL7p';

/** Готовит чистую схему базы данных с 20 ячейками. */
function prepareDatabase() {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');

  const insert = getDb().prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  getDb().transaction(() => {
    for (let number = 1; number <= 20; number += 1) insert.run(number);
  })();
}

/**
 * Создаёт подтверждённого пользователя с указанной ролью.
 * @param {string} email
 * @param {'client'|'admin'} role
 */
async function createUser(email, role = 'client') {
  const { user } = await authService.register({
    name: 'Тестовый Пользователь',
    email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  });

  confirmationService.confirmEmail(userRepository.findById(user.id).confirmToken);

  if (role !== 'client') {
    getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);
  }

  return userRepository.findById(user.id);
}

// ---------------------------------------------------------------------------
//  Роли пользователей
// ---------------------------------------------------------------------------

test('новый пользователь получает роль client', async () => {
  prepareDatabase();
  const user = await createUser('client@mail.ru');

  assert.equal(user.role, 'client');
  assert.equal(user.isConfirmed, true);
});

test('роль администратора устанавливается в базе данных', async () => {
  prepareDatabase();
  const user = await createUser('admin@mail.ru', 'admin');

  assert.equal(user.role, 'admin');

  const row = getDb().prepare('SELECT role FROM Users WHERE id = ?').get(user.id);
  assert.equal(row.role, 'admin');
});

test('база данных не принимает произвольные роли', async () => {
  prepareDatabase();
  const user = await createUser('client@mail.ru');

  assert.throws(
    () => getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run('superuser', user.id),
    /CHECK constraint failed|constraint/i,
  );
});

test('вход возвращает роль пользователя', async () => {
  prepareDatabase();
  await createUser('admin@mail.ru', 'admin');

  const result = await authService.login({ email: 'admin@mail.ru', password: PASSWORD });
  assert.equal(result.user.role, 'admin');
});

// ---------------------------------------------------------------------------
//  Ячейки хранения: просмотр
// ---------------------------------------------------------------------------

test('список ячеек возвращается со сводкой по состоянию', () => {
  prepareDatabase();

  const { cells, summary } = cellService.listCells();

  assert.equal(cells.length, 20);
  assert.equal(summary.total, 20);
  assert.equal(summary.free, 20);
  assert.equal(summary.busy, 0);
  assert.equal(summary.occupancyPercent, 0);
});

test('ячейки отсортированы по номеру', () => {
  prepareDatabase();

  const { cells } = cellService.listCells();
  const numbers = cells.map((cell) => cell.cellNumber);

  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  assert.equal(numbers[0], 1);
  assert.equal(numbers[19], 20);
});

test('фильтр по состоянию «Свободна» возвращает только свободные ячейки', () => {
  prepareDatabase();
  const freeCell = cellRepository.findByNumber(1);
  cellRepository.updateStatus(freeCell.id, 'Занята');

  const { cells, summary } = cellService.listCells({ status: 'Свободна' });

  assert.equal(cells.length, 19);
  assert.ok(cells.every((cell) => cell.status === 'Свободна'));
  assert.equal(summary.free, 19);
  assert.equal(summary.busy, 1);
});

test('недопустимое значение фильтра отклоняется (400)', () => {
  prepareDatabase();

  assert.throws(
    () => cellService.listCells({ status: 'Сломана' }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 400);
      assert.ok(error.details.status);
      return true;
    },
  );
});

test('процент заполненности рассчитывается верно', () => {
  prepareDatabase();

  // Занимаем 5 ячеек из 20 — заполненность 25 %
  for (let number = 1; number <= 5; number += 1) {
    cellRepository.updateStatus(cellRepository.findByNumber(number).id, 'Занята');
  }

  const { summary } = cellService.listCells();

  assert.equal(summary.busy, 5);
  assert.equal(summary.free, 15);
  assert.equal(summary.occupancyPercent, 25);
});

test('сведения об одной ячейке возвращаются по идентификатору', () => {
  prepareDatabase();
  const cell = cellRepository.findByNumber(7);

  const found = cellService.getCell(cell.id);
  assert.equal(found.cellNumber, 7);
});

test('несуществующая ячейка возвращает ошибку 404', () => {
  prepareDatabase();

  assert.throws(
    () => cellService.getCell(9999),
    (error) => error.status === 404,
  );
});

// ---------------------------------------------------------------------------
//  Ячейки хранения: изменение (администратор)
// ---------------------------------------------------------------------------

test('добавление ячейки с указанным номером', () => {
  prepareDatabase();

  const cell = cellService.addCell({ cellNumber: 50 });

  assert.equal(cell.cellNumber, 50);
  assert.equal(cell.status, 'Свободна');
  assert.equal(cellRepository.count(), 21);
});

test('добавление ячейки без номера использует следующий номер', () => {
  prepareDatabase();

  const cell = cellService.addCell({});

  assert.equal(cell.cellNumber, 21, 'следующий за наибольшим существующим');
});

test('повторяющийся номер ячейки отклоняется (409)', () => {
  prepareDatabase();

  assert.throws(
    () => cellService.addCell({ cellNumber: 5 }),
    (error) => {
      assert.equal(error.status, 409);
      assert.ok(error.details.cellNumber);
      return true;
    },
  );
});

test('некорректный номер ячейки отклоняется (400)', () => {
  prepareDatabase();

  const invalid = [0, -3, 'abc', 1000];
  for (const cellNumber of invalid) {
    assert.throws(
      () => cellService.addCell({ cellNumber }),
      (error) => error.status === 400,
      `номер ${JSON.stringify(cellNumber)} должен отклоняться`,
    );
  }
});

test('изменение состояния ячейки', () => {
  prepareDatabase();
  const cell = cellRepository.findByNumber(3);

  const busy = cellService.setCellStatus(cell.id, 'Занята');
  assert.equal(busy.status, 'Занята');

  const free = cellService.setCellStatus(cell.id, 'Свободна');
  assert.equal(free.status, 'Свободна');
});

test('недопустимое состояние ячейки отклоняется (400)', () => {
  prepareDatabase();
  const cell = cellRepository.findByNumber(3);

  assert.throws(
    () => cellService.setCellStatus(cell.id, 'Сломана'),
    (error) => error.status === 400,
  );

  assert.throws(
    () => cellService.setCellStatus(cell.id, undefined),
    (error) => error.status === 400,
  );
});

test('нельзя освободить ячейку с активным заказом (409)', () => {
  prepareDatabase();
  const cell = cellRepository.findByNumber(10);
  const user = getDb()
    .prepare("INSERT INTO Users (name, email, password_hash, is_confirmed) VALUES ('Клиент', 'c@mail.ru', 'x', 1)")
    .run();
  getDb()
    .prepare(
      `INSERT INTO Orders (track_number, user_id, cell_id, status, received_at)
       VALUES ('TRACK-1', ?, ?, 'Готов к выдаче', datetime('now'))`,
    )
    .run(user.lastInsertRowid, cell.id);

  cellRepository.updateStatus(cell.id, 'Занята');

  assert.throws(
    () => cellService.setCellStatus(cell.id, 'Свободна'),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /заказ/i);
      return true;
    },
  );
});

test('удаление свободной ячейки', () => {
  prepareDatabase();
  const cell = cellRepository.findByNumber(20);

  cellService.deleteCell(cell.id);

  assert.equal(cellRepository.findById(cell.id), null);
  assert.equal(cellRepository.count(), 19);
});

test('нельзя удалить ячейку со связанными заказами (409)', () => {
  prepareDatabase();
  const cell = cellRepository.findByNumber(12);
  const user = getDb()
    .prepare("INSERT INTO Users (name, email, password_hash, is_confirmed) VALUES ('Клиент', 'c@mail.ru', 'x', 1)")
    .run();
  getDb()
    .prepare(
      `INSERT INTO Orders (track_number, user_id, cell_id, status, received_at, issued_at)
       VALUES ('TRACK-2', ?, ?, 'Выдан', datetime('now'), datetime('now'))`,
    )
    .run(user.lastInsertRowid, cell.id);

  assert.throws(
    () => cellService.deleteCell(cell.id),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.details.cellNumber.code, 'HAS_ORDERS');
      return true;
    },
  );

  assert.ok(cellRepository.findById(cell.id), 'ячейка должна остаться в справочнике');
});

test('удаление несуществующей ячейки — ошибка 404', () => {
  prepareDatabase();

  assert.throws(() => cellService.deleteCell(9999), (error) => error.status === 404);
});

test('список ячеек со сведениями о заказах', () => {
  prepareDatabase();
  const cell = cellRepository.findByNumber(4);
  const user = getDb()
    .prepare("INSERT INTO Users (name, email, password_hash, is_confirmed) VALUES ('Клиент', 'c@mail.ru', 'x', 1)")
    .run();
  getDb()
    .prepare(
      `INSERT INTO Orders (track_number, user_id, cell_id, status, received_at)
       VALUES ('TRACK-3', ?, ?, 'Готов к выдаче', datetime('now'))`,
    )
    .run(user.lastInsertRowid, cell.id);
  cellRepository.updateStatus(cell.id, 'Занята');

  const { cells } = cellService.listCells({ withOrders: true });

  const busy = cells.find((item) => item.cellNumber === 4);
  assert.equal(busy.status, 'Занята');
  assert.equal(busy.trackNumber, 'TRACK-3');

  const free = cells.find((item) => item.cellNumber === 5);
  assert.equal(free.orderId, undefined, 'у свободной ячейки нет связанного заказа');
  assert.equal(free.trackNumber, undefined);
});

test('завершение работы: соединение с базой данных закрывается', () => {
  closeDb();
});
