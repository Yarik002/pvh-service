'use strict';

/**
 * Тесты алгоритма назначения ячейки хранения (13-й день практики).
 *
 * Проверяется:
 *   • автоматический выбор первой свободной ячейки по номеру;
 *   • ручной выбор ячейки по идентификатору или номеру;
 *   • понятные отказы: свободных нет, ячейка занята, не найдена, не указана;
 *   • предварительный выбор не изменяет базу данных;
 *   • одну ячейку нельзя занять дважды;
 *   • адрес GET /api/cells/suggest и разграничение доступа к нему.
 *
 * Запуск:  node tests/cellAssignment.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.MAIL_TRANSPORT = 'log';
process.env.LOGIN_LIMIT_MAX = '500';
process.env.RATE_LIMIT_MAX = '500';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const authService = require('../src/services/authService');
const confirmationService = require('../src/services/confirmationService');
const userRepository = require('../src/repositories/userRepository');
const { chooseCell, occupyCell, assignCell, ASSIGN_ERRORS } = require('../src/services/cellAssignment');

const PASSWORD = 'Xk9#mQ2$vL7p';

/**
 * Готовит справочник ячеек.
 * @param {number[]} numbers номера ячеек в порядке добавления
 */
function prepareCells(numbers = Array.from({ length: 20 }, (_, i) => i + 1)) {
  runMigrations();
  getDb().exec('DELETE FROM Sessions; DELETE FROM Orders; DELETE FROM Users; DELETE FROM Storage_Cells;');

  const insert = getDb().prepare("INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')");
  getDb().transaction(() => numbers.forEach((number) => insert.run(number)))();
}

/** Помечает ячейки с указанными номерами занятыми. */
function makeBusy(...numbers) {
  const update = getDb().prepare("UPDATE Storage_Cells SET status = 'Занята' WHERE cell_number = ?");
  numbers.forEach((number) => update.run(number));
}

/** Идентификатор ячейки по номеру. */
function idOf(number) {
  return getDb().prepare('SELECT id FROM Storage_Cells WHERE cell_number = ?').get(number).id;
}

/** Состояние ячейки по номеру. */
function statusOf(number) {
  return getDb().prepare('SELECT status FROM Storage_Cells WHERE cell_number = ?').get(number).status;
}

/** Проверяет, что вызов завершился прикладной ошибкой с кодом и статусом. */
function assertAppError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, status, `HTTP-статус: ${error.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
//  Автоматический выбор
// ---------------------------------------------------------------------------

test('автоматически выбирается первая свободная ячейка', () => {
  prepareCells();

  const choice = chooseCell({ mode: 'auto' });

  assert.equal(choice.mode, 'auto');
  assert.equal(choice.cell.cellNumber, 1);
  assert.match(choice.message, /№ 1 — первая свободная/);
});

test('по умолчанию используется автоматический выбор', () => {
  prepareCells();
  assert.equal(chooseCell().mode, 'auto');
  assert.equal(chooseCell({ mode: '' }).mode, 'auto');
});

test('занятые ячейки пропускаются', () => {
  prepareCells();
  makeBusy(1, 2, 3);

  assert.equal(chooseCell().cell.cellNumber, 4);
});

test('порядок определяется номером ячейки, а не порядком добавления', () => {
  // Ячейки добавлены вразнобой: у ячейки № 1 не наименьший идентификатор
  prepareCells([7, 3, 12, 1, 5]);

  assert.equal(chooseCell().cell.cellNumber, 1);

  makeBusy(1);
  assert.equal(chooseCell().cell.cellNumber, 3);
});

test('если свободных ячеек нет, алгоритм сообщает об этом', () => {
  prepareCells();
  makeBusy(...Array.from({ length: 20 }, (_, i) => i + 1));

  assertAppError(() => chooseCell(), 409, ASSIGN_ERRORS.NO_FREE_CELLS);
  assert.throws(() => chooseCell(), /Свободных ячеек нет: все 20 ячеек заняты/);
});

test('пустой справочник ячеек — отдельное понятное сообщение', () => {
  prepareCells([]);

  assertAppError(() => chooseCell(), 409, ASSIGN_ERRORS.NO_FREE_CELLS);
  assert.throws(() => chooseCell(), /нет ни одной ячейки/);
});

// ---------------------------------------------------------------------------
//  Ручной выбор
// ---------------------------------------------------------------------------

test('вручную можно выбрать свободную ячейку по идентификатору', () => {
  prepareCells();

  const choice = chooseCell({ mode: 'manual', cellId: idOf(15) });

  assert.equal(choice.mode, 'manual');
  assert.equal(choice.cell.cellNumber, 15);
});

test('вручную можно выбрать ячейку по номеру', () => {
  prepareCells();

  assert.equal(chooseCell({ mode: 'manual', cellNumber: '8' }).cell.cellNumber, 8);
});

test('занятую ячейку выбрать нельзя, предлагается ближайшая свободная', () => {
  prepareCells();
  makeBusy(1, 5);

  assert.throws(() => chooseCell({ mode: 'manual', cellNumber: 5 }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, ASSIGN_ERRORS.CELL_BUSY);
    assert.match(error.message, /Ячейка № 5 занята\. Ближайшая свободная — № 2/);
    assert.equal(error.details.cell.suggestedCellNumber, 2);
    return true;
  });
});

test('несуществующая ячейка — 404', () => {
  prepareCells();

  assertAppError(() => chooseCell({ mode: 'manual', cellNumber: 999 }), 404, ASSIGN_ERRORS.CELL_NOT_FOUND);
  assertAppError(() => chooseCell({ mode: 'manual', cellId: 999999 }), 404, ASSIGN_ERRORS.CELL_NOT_FOUND);
});

test('при ручном выборе ячейка обязательна и проверяется', () => {
  prepareCells();

  assertAppError(() => chooseCell({ mode: 'manual' }), 400, ASSIGN_ERRORS.CELL_REQUIRED);
  for (const value of ['abc', '0', '-2', '1.5']) {
    assertAppError(() => chooseCell({ mode: 'manual', cellId: value }), 400, ASSIGN_ERRORS.INVALID_CELL);
  }
});

test('неизвестный способ выбора отклоняется', () => {
  prepareCells();
  assertAppError(() => chooseCell({ mode: 'random' }), 400, ASSIGN_ERRORS.INVALID_MODE);
});

// ---------------------------------------------------------------------------
//  Занятие ячейки
// ---------------------------------------------------------------------------

test('предварительный выбор не изменяет базу данных', () => {
  prepareCells();

  chooseCell();
  chooseCell({ mode: 'manual', cellNumber: 4 });

  assert.equal(statusOf(1), 'Свободна');
  assert.equal(statusOf(4), 'Свободна');
});

test('назначение занимает выбранную ячейку', () => {
  prepareCells();

  const first = assignCell();
  const second = assignCell();
  const manual = assignCell({ mode: 'manual', cellNumber: 10 });

  assert.equal(first.cell.cellNumber, 1);
  assert.equal(second.cell.cellNumber, 2, 'следующая свободная после занятой');
  assert.equal(manual.cell.cellNumber, 10);
  assert.equal(statusOf(1), 'Занята');
  assert.equal(statusOf(10), 'Занята');
  assert.equal(chooseCell().cell.cellNumber, 3);
});

test('одну ячейку нельзя занять дважды', () => {
  prepareCells();
  const id = idOf(6);

  occupyCell(id);
  assertAppError(() => occupyCell(id), 409, ASSIGN_ERRORS.CELL_BUSY);
});

test('после заполнения всех ячеек алгоритм сообщает об отсутствии свободных', () => {
  prepareCells([1, 2, 3]);

  assignCell();
  assignCell();
  assignCell();

  assertAppError(() => assignCell(), 409, ASSIGN_ERRORS.NO_FREE_CELLS);
});

test('при ошибке внутри внешней транзакции занятие ячейки отменяется', () => {
  prepareCells();

  assert.throws(() => getDb().transaction(() => {
    assignCell();
    // Например, приёмка заказа не удалась после назначения ячейки
    throw new Error('сбой приёмки');
  })(), /сбой приёмки/);

  assert.equal(statusOf(1), 'Свободна', 'ячейка осталась свободной');
});

// ---------------------------------------------------------------------------
//  GET /api/cells/suggest
// ---------------------------------------------------------------------------

/** Поднимает сервер, создаёт пользователей и возвращает их токены. */
async function withServer(run) {
  prepareCells();
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const loginAs = async (email, role) => {
    const { user } = await authService.register({
      name: 'Тестовый Пользователь', email, password: PASSWORD, passwordConfirm: PASSWORD,
    });
    confirmationService.confirmEmail(userRepository.findById(user.id).confirmToken);
    getDb().prepare('UPDATE Users SET role = ? WHERE id = ?').run(role, user.id);

    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return (await response.json()).token;
  };

  const call = async (path, token) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, { headers });
    return { status: response.status, body: await response.json() };
  };

  try {
    await run({ loginAs, call });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('администратор получает предложенную ячейку через API', async () => {
  await withServer(async ({ loginAs, call }) => {
    const token = await loginAs('admin@mail.ru', 'admin');
    makeBusy(1);

    const auto = await call('/api/cells/suggest', token);
    assert.equal(auto.status, 200);
    assert.equal(auto.body.cell.cellNumber, 2);
    assert.equal(statusOf(2), 'Свободна', 'ячейка не занята');

    const manual = await call('/api/cells/suggest?mode=manual&cellNumber=9', token);
    assert.equal(manual.body.cell.cellNumber, 9);

    const busy = await call('/api/cells/suggest?mode=manual&cellNumber=1', token);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'CELL_BUSY');
  });
});

test('API сообщает об отсутствии свободных ячеек', async () => {
  await withServer(async ({ loginAs, call }) => {
    const token = await loginAs('admin@mail.ru', 'admin');
    getDb().exec("UPDATE Storage_Cells SET status = 'Занята'");

    const response = await call('/api/cells/suggest', token);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'NO_FREE_CELLS');
    assert.match(response.body.error.message, /Свободных ячеек нет/);
  });
});

test('выбор ячейки недоступен клиенту и гостю', async () => {
  await withServer(async ({ loginAs, call }) => {
    const clientToken = await loginAs('client@mail.ru', 'client');

    assert.equal((await call('/api/cells/suggest', clientToken)).status, 403);
    assert.equal((await call('/api/cells/suggest')).status, 401);
  });
});

test.after(() => closeDb());
