'use strict';

/**
 * Очистка тестовых данных.
 *
 * Удаляет всё, что накопилось при проверке работы приложения, но сохраняет
 * то, что нужно для дальнейшего показа:
 *   • учётную запись администратора (иначе некому войти в админку);
 *   • справочник ячеек хранения (20 записей);
 *   • структуру базы данных (миграции не затрагиваются).
 *
 * Удаляется:
 *   • все заказы;
 *   • все сессии (все пользователи разлогиниваются);
 *   • все учётные записи, кроме администратора.
 *
 * Использование:
 *   npm run db:clean
 *
 * Запускать при остановленном сервере: иначе он продолжит работать
 * со старыми данными, и очистка будет не видна до перезапуска.
 */

const config = require('../src/config');
const logger = require('../src/utils/logger');
const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

function main() {
  logger.info('='.repeat(70));
  logger.info('ОЧИСТКА ТЕСТОВЫХ ДАННЫХ');
  logger.info('='.repeat(70));
  logger.info(`База данных: ${config.database.file}`);

  const db = getDb();
  runMigrations();

  // --- Сколько данных было ---------------------------------------------
  const before = {
    users: db.prepare('SELECT COUNT(*) AS c FROM Users').get().c,
    orders: db.prepare('SELECT COUNT(*) AS c FROM Orders').get().c,
    sessions: db.prepare('SELECT COUNT(*) AS c FROM Sessions').get().c,
    busyCells: db.prepare("SELECT COUNT(*) AS c FROM Storage_Cells WHERE status = 'Занята'").get().c,
  };

  logger.info(`Было: пользователей ${before.users}, заказов ${before.orders}, `
    + `сессий ${before.sessions}, занятых ячеек ${before.busyCells}`);

  // --- Очистка одним действием -----------------------------------------
  // Транзакция: если что-то пойдёт не так, база останется как была.
  // Порядок важен из-за ссылочной целостности: сначала зависимые записи.
  const clean = db.transaction(() => {
    // Сессии удаляются и каскадно вместе с пользователями,
    // но выполняем явно — так понятнее и надёжнее
    const sessions = db.prepare('DELETE FROM Sessions').run().changes;

    // Заказы удаляются до пользователей: на них ссылается cell_id
    const orders = db.prepare('DELETE FROM Orders').run().changes;

    // Все пользователи, кроме администраторов
    const users = db.prepare("DELETE FROM Users WHERE role <> 'admin'").run().changes;

    // Освобождаем ячейки: после удаления заказов они не должны быть заняты
    const cells = db
      .prepare("UPDATE Storage_Cells SET status = 'Свободна' WHERE status <> 'Свободна'")
      .run().changes;

    return { sessions, orders, users, cells };
  });

  const removed = clean();

  // --- Что осталось ----------------------------------------------------
  const after = {
    users: db.prepare('SELECT COUNT(*) AS c FROM Users').get().c,
    orders: db.prepare('SELECT COUNT(*) AS c FROM Orders').get().c,
    sessions: db.prepare('SELECT COUNT(*) AS c FROM Sessions').get().c,
    freeCells: db.prepare("SELECT COUNT(*) AS c FROM Storage_Cells WHERE status = 'Свободна'").get().c,
  };

  const admins = db
    .prepare("SELECT email FROM Users WHERE role = 'admin' ORDER BY id")
    .all()
    .map((row) => row.email);

  logger.info(`Удалено: пользователей ${removed.users}, заказов ${removed.orders}, `
    + `сессий ${removed.sessions}, освобождено ячеек ${removed.cells}`);

  logger.info('-'.repeat(70));
  logger.info(`Осталось: пользователей ${after.users}, заказов ${after.orders}, `
    + `сессий ${after.sessions}, свободных ячеек ${after.freeCells}`);
  logger.info(`Администраторы: ${admins.join(', ') || '(нет)'}`);
  logger.info('='.repeat(70));
  logger.info('База готова: можно регистрировать новую учётную запись.');
  logger.info('Порядок показа: npm run demo');
  logger.info('='.repeat(70));

  closeDb();
}

try {
  main();
} catch (error) {
  logger.error('Ошибка очистки базы данных:', error);
  closeDb();
  process.exit(1);
}
