'use strict';

/**
 * Проверка сборки v0.12 (13-й день практики).
 *
 * Тема дня: алгоритм автоматического назначения первой свободной ячейки
 * или ручного выбора.
 * Критерий приёмки: алгоритм успешно находит ячейку или сообщает,
 * что свободных нет.
 *
 * Сценарий заполняет склад заказами до последней ячейки и проверяет
 * поведение алгоритма на каждом этапе: пустой склад, частично занятый,
 * полностью занятый.
 *
 * Запуск:  node scripts/check-v0.12.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `pvh-check-v012-${process.pid}.db`);
process.env.DB_FILE = TMP_DB;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.LOGIN_LIMIT_MAX = process.env.LOGIN_LIMIT_MAX || '500';
process.env.MAIL_TRANSPORT = 'log';

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { createApp } = require('../src/app');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { hashPassword } = require('../src/utils/password');
const userRepository = require('../src/repositories/userRepository');
const { chooseCell, occupyCell, assignCell } = require('../src/services/cellAssignment');

const PORT = Number.parseInt(process.env.CHECK_PORT || '3121', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Xk9#mQ2$vL7p';
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'ПРОЙДЕНО' : 'ОШИБКА  '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Выполняет вызов и возвращает ошибку (или null, если ошибки не было). */
function catchError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/** Выполняет запрос к API. */
async function api(endpoint, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${endpoint}`, { headers });
  return { status: response.status, body: await response.json() };
}

/** Создаёт подтверждённого пользователя и выполняет вход. */
async function createAndLogin(email, role) {
  userRepository.create({
    name: 'Пользователь Проверки',
    email,
    passwordHash: await hashPassword(PASSWORD),
    role,
    isConfirmed: true,
  });

  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (await response.json()).token;
}

/** Состояние ячейки по номеру. */
function statusOf(number) {
  return getDb().prepare('SELECT status FROM Storage_Cells WHERE cell_number = ?').get(number)?.status;
}

async function main() {
  console.log('='.repeat(78));
  console.log(`ПРОВЕРКА СБОРКИ v${config.version} — алгоритм назначения ячейки`);
  console.log('='.repeat(78));

  getDb();
  runMigrations();

  const moduleFile = path.join(config.rootDir, 'src', 'services', 'cellAssignment.js');
  check('Модуль алгоритма назначения ячейки (src/services/cellAssignment.js)',
    fs.existsSync(moduleFile));

  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  check('Сервер запущен', true, BASE);

  try {
    const stamp = Date.now();
    const adminToken = await createAndLogin(`admin_${stamp}@mail.ru`, 'admin');
    const clientToken = await createAndLogin(`client_${stamp}@mail.ru`, 'client');

    check('В справочнике 20 свободных ячеек',
      getDb().prepare("SELECT COUNT(*) AS n FROM Storage_Cells WHERE status = 'Свободна'").get().n === 20);

    // --- 1. Автоматический выбор ----------------------------------------------------
    const first = chooseCell({ mode: 'auto' });
    check('Автоматически выбрана первая свободная ячейка № 1', first.cell.cellNumber === 1, first.message);
    check('Предварительный выбор не занимает ячейку', statusOf(1) === 'Свободна');

    const assigned = assignCell();
    check('Назначение занимает ячейку № 1', assigned.cell.cellNumber === 1 && statusOf(1) === 'Занята');
    check('Следующей автоматически выбирается ячейка № 2', chooseCell().cell.cellNumber === 2);

    // --- 2. Ручной выбор --------------------------------------------------------------
    const manual = chooseCell({ mode: 'manual', cellNumber: 15 });
    check('Вручную выбрана свободная ячейка № 15', manual.cell.cellNumber === 15, manual.message);

    assignCell({ mode: 'manual', cellNumber: 15 });
    const busyError = catchError(() => chooseCell({ mode: 'manual', cellNumber: 15 }));
    check('Занятую ячейку выбрать вручную нельзя (409)',
      busyError?.status === 409 && busyError.code === 'CELL_BUSY', busyError?.message);
    check('При отказе предлагается ближайшая свободная ячейка',
      busyError?.details?.cell?.suggestedCellNumber === 2);

    const missingError = catchError(() => chooseCell({ mode: 'manual', cellNumber: 500 }));
    check('Несуществующая ячейка — 404', missingError?.status === 404, missingError?.message);

    const emptyError = catchError(() => chooseCell({ mode: 'manual' }));
    check('Ручной выбор без указания ячейки отклоняется (400)',
      emptyError?.status === 400 && emptyError.code === 'CELL_REQUIRED', emptyError?.message);

    const modeError = catchError(() => chooseCell({ mode: 'random' }));
    check('Неизвестный способ выбора отклоняется (400)',
      modeError?.status === 400 && modeError.code === 'INVALID_ASSIGN_MODE');

    // --- 3. Защита от двойного занятия -------------------------------------------------
    const cell2 = getDb().prepare('SELECT id FROM Storage_Cells WHERE cell_number = 2').get().id;
    occupyCell(cell2);
    const doubleError = catchError(() => occupyCell(cell2));
    check('Одну ячейку нельзя занять дважды (409)', doubleError?.status === 409, doubleError?.message);

    const rollback = catchError(() => getDb().transaction(() => {
      assignCell();
      throw new Error('сбой приёмки');
    })());
    check('При сбое приёмки занятие ячейки отменяется',
      rollback?.message === 'сбой приёмки' && statusOf(3) === 'Свободна');

    // --- 4. API предварительного выбора -------------------------------------------------
    const suggest = await api('/api/cells/suggest', adminToken);
    check('GET /api/cells/suggest предлагает первую свободную ячейку (№ 3)',
      suggest.status === 200 && suggest.body.cell?.cellNumber === 3, suggest.body.message);

    const suggestManual = await api('/api/cells/suggest?mode=manual&cellNumber=20', adminToken);
    check('GET /api/cells/suggest принимает ручной выбор', suggestManual.body.cell?.cellNumber === 20);

    const suggestBusy = await api('/api/cells/suggest?mode=manual&cellNumber=1', adminToken);
    check('API сообщает, что выбранная ячейка занята (409)',
      suggestBusy.status === 409 && suggestBusy.body.error?.code === 'CELL_BUSY');

    const forClient = await api('/api/cells/suggest', clientToken);
    const forGuest = await api('/api/cells/suggest');
    check('Выбор ячейки доступен только администратору (403 / 401)',
      forClient.status === 403 && forGuest.status === 401);

    // --- 5. Склад заполнен ----------------------------------------------------------------
    let filled = 0;
    while (chooseCellSafe()) {
      assignCell();
      filled += 1;
    }
    // К этому моменту заняты ячейки 1, 2 и 15 — остаётся 17 свободных
    check('Склад заполнен до последней ячейки', filled === 17 && statusOf(20) === 'Занята',
      `дополнительно занято ячеек: ${filled}`);

    const noFree = catchError(() => chooseCell());
    check('Алгоритм сообщает, что свободных ячеек нет (409)',
      noFree?.status === 409 && noFree.code === 'NO_FREE_CELLS', noFree?.message);

    const noFreeApi = await api('/api/cells/suggest', adminToken);
    check('API сообщает об отсутствии свободных ячеек',
      noFreeApi.status === 409 && noFreeApi.body.error?.code === 'NO_FREE_CELLS');

    const assignWhenFull = catchError(() => assignCell());
    check('Назначение при заполненном складе не выполняется', assignWhenFull?.status === 409);

    const freeList = await api('/api/cells/free', adminToken);
    check('Список свободных ячеек пуст', freeList.body.count === 0 && freeList.body.firstFreeNumber === null);

    // --- 6. Освобождение ячейки ------------------------------------------------------------
    getDb().prepare("UPDATE Storage_Cells SET status = 'Свободна' WHERE cell_number = 11").run();
    check('После освобождения ячейки алгоритм снова её находит', chooseCell().cell.cellNumber === 11);

    // --- 7. Ранее созданные разделы ---------------------------------------------------------
    const cells = await api('/api/cells', clientToken);
    check('GET /api/cells по-прежнему отдаёт 20 ячеек', cells.body.cells?.length === 20);

    const health = await api('/health');
    check('Эндпоинт /health по-прежнему возвращает OK', health.body.status === 'OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${TMP_DB}${suffix}`, { force: true });
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log('-'.repeat(78));
  console.log(`Всего проверок: ${results.length}, пройдено: ${results.length - failed.length}, ошибок: ${failed.length}`);

  if (failed.length === 0) {
    console.log(`РЕЗУЛЬТАТ: сборка v${config.version} соответствует критерию приёмки — `
      + 'алгоритм находит ячейку или сообщает, что свободных нет.');
    console.log('='.repeat(78));
    return 0;
  }

  console.log('РЕЗУЛЬТАТ: сборка НЕ прошла проверку. Не пройденные проверки:');
  failed.forEach((r) => console.log(`  • ${r.name} (${r.detail})`));
  console.log('='.repeat(78));
  return 1;
}

/** Есть ли ещё свободная ячейка (без исключения). */
function chooseCellSafe() {
  return catchError(() => chooseCell()) === null;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    logger.error('Ошибка выполнения проверки:', error);
    closeDb();
    process.exit(1);
  });
