'use strict';

/**
 * Начальная настройка базы данных (npm run seed).
 *
 * Сценарий выполняет действия, необходимые для первого запуска проекта:
 *   1) создаёт учётную запись администратора (если её ещё нет);
 *   2) дополняет справочник ячеек хранения до заданного количества.
 *
 * Параметры берутся из файла настроек (.env):
 *   ADMIN_EMAIL     — адрес электронной почты администратора;
 *   ADMIN_NAME      — имя администратора;
 *   ADMIN_PASSWORD  — пароль администратора (если не указан, используется
 *                     значение по умолчанию из сценария, о чём выводится
 *                     предупреждение);
 *   SEED_CELLS_COUNT — сколько ячеек должно быть в справочнике (по умолчанию 20).
 *
 * Запуск:  npm run seed
 */

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { hashPassword } = require('../src/utils/password');
const { analyzePassword } = require('../src/utils/passwordStrength');
const userRepository = require('../src/repositories/userRepository');
const cellRepository = require('../src/repositories/cellRepository');

/** Пароль администратора по умолчанию — только для учебного проекта. */
const DEFAULT_ADMIN_PASSWORD = 'Admin#2026Pvh';

/**
 * Создаёт администратора, если его ещё нет.
 * Если пользователь с указанным адресом существует, ему выдаётся роль admin
 * и подтверждается адрес электронной почты.
 *
 * @returns {Promise<{created: boolean, updated: boolean, user: object|null, password: string|null}>}
 */
async function seedAdmin() {
  const email = config.seed.adminEmail;
  const name = config.seed.adminName;

  const password = config.seed.adminPassword || DEFAULT_ADMIN_PASSWORD;
  const usingDefaultPassword = !config.seed.adminPassword;

  const existing = userRepository.findByEmail(email);

  if (existing) {
    let updated = false;

    // Выдаём роль администратора и подтверждаем адрес электронной почты
    if (existing.role !== 'admin' || !existing.isConfirmed) {
      getDb()
        .prepare("UPDATE Users SET role = 'admin', is_confirmed = 1, confirm_token = NULL WHERE id = ?")
        .run(existing.id);
      updated = true;
      logger.info(`Пользователю ${email} выдана роль администратора, адрес подтверждён`);
    } else {
      logger.info(`Администратор ${email} уже существует`);
    }

    return { created: false, updated, user: userRepository.findById(existing.id), password: null };
  }

  const strength = analyzePassword(password, { name, email });
  if (strength.score < 40) {
    logger.warn(`Пароль администратора имеет низкую надёжность (${strength.score} из 100). `
      + 'Укажите более стойкий пароль в параметре ADMIN_PASSWORD.');
  }

  const passwordHash = await hashPassword(password);
  const user = userRepository.create({
    name,
    email,
    passwordHash,
    role: 'admin',
    isConfirmed: true,
    confirmToken: null,
  });

  logger.info(`Создан администратор: ${user.email} (id=${user.id})`);

  return {
    created: true,
    updated: false,
    user,
    password: usingDefaultPassword ? password : null,
  };
}

/**
 * Дополняет справочник ячеек хранения до нужного количества.
 * Существующие ячейки не изменяются.
 *
 * @param {number} targetCount требуемое количество ячеек
 * @returns {{added: number, total: number}}
 */
function seedCells(targetCount) {
  const current = cellRepository.count();

  if (current >= targetCount) {
    logger.info(`Справочник ячеек уже содержит ${current} записей (требуется ${targetCount})`);
    return { added: 0, total: current };
  }

  // Нумеруем новые ячейки, продолжая существующую нумерацию
  let nextNumber = cellRepository.getMaxCellNumber() + 1;
  const insert = getDb().prepare(
    "INSERT INTO Storage_Cells (cell_number, status) VALUES (?, 'Свободна')",
  );

  const addMany = getDb().transaction((count) => {
    for (let i = 0; i < count; i += 1) {
      insert.run(nextNumber);
      nextNumber += 1;
    }
  });

  const toAdd = targetCount - current;
  addMany(toAdd);

  logger.info(`Добавлено ячеек: ${toAdd} (всего ${cellRepository.count()})`);

  return { added: toAdd, total: cellRepository.count() };
}

async function main() {
  logger.info('='.repeat(74));
  logger.info('НАЧАЛЬНАЯ НАСТРОЙКА ДАННЫХ ПРОЕКТА');
  logger.info('='.repeat(74));

  getDb();
  runMigrations();

  // --- Администратор ----------------------------------------------------
  const admin = await seedAdmin();

  if (admin.created && admin.password) {
    logger.info('-'.repeat(74));
    logger.info('Данные для входа администратора:');
    logger.info(`  Адрес электронной почты: ${config.seed.adminEmail}`);
    logger.info(`  Пароль:                  ${admin.password}`);
    logger.warn('Пароль создан по умолчанию — смените его после первого входа.');
    logger.info('-'.repeat(74));
  } else if (admin.created) {
    logger.info(`Администратор создан. Пароль задан в параметре ADMIN_PASSWORD.`);
  }

  // --- Ячейки хранения ---------------------------------------------------
  const targetCells = Number.parseInt(process.env.SEED_CELLS_COUNT || '20', 10);
  const cells = seedCells(Number.isInteger(targetCells) && targetCells > 0 ? targetCells : 20);

  // --- Итог --------------------------------------------------------------
  const users = userRepository.count();
  const confirmed = getDb().prepare('SELECT COUNT(*) AS n FROM Users WHERE is_confirmed = 1').get().n;

  logger.info('='.repeat(74));
  logger.info('Начальная настройка завершена.');
  logger.info(`Пользователей: ${users} (из них подтверждено: ${confirmed})`);
  logger.info(`Ячеек хранения: ${cells.total} (свободно: ${cellRepository.countByStatus('Свободна')})`);
  logger.info('Запуск сервера:  npm start');
  logger.info('='.repeat(74));

  closeDb();
}

main().catch((error) => {
  logger.error('Ошибка начальной настройки данных:', error);
  closeDb();
  process.exit(1);
});
