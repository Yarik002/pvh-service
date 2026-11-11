'use strict';

/**
 * Доступ к данным заказов (таблица Orders).
 *
 * Все запросы к заказам собраны в этом модуле. Заказ возвращается вместе
 * со сведениями о получателе и ячейке, чтобы сервисам не приходилось
 * выполнять дополнительные запросы.
 */

const { getDb } = require('../db/connection');
const { toIso } = require('../utils/datetime');

/** Запрос заказа вместе с получателем и ячейкой. */
const SELECT_ORDER = `
  SELECT o.id, o.track_number, o.description, o.status, o.received_at, o.issued_at,
         o.user_id, u.name AS user_name, u.email AS user_email,
         o.cell_id, c.cell_number
    FROM Orders o
    JOIN Users u ON u.id = o.user_id
    LEFT JOIN Storage_Cells c ON c.id = o.cell_id`;

/** Приводит строку базы данных к удобному для клиента виду. */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    trackNumber: row.track_number,
    description: row.description,
    status: row.status,
    receivedAt: toIso(row.received_at),
    issuedAt: toIso(row.issued_at),
    client: { id: row.user_id, name: row.user_name, email: row.user_email },
    cell: row.cell_id ? { id: row.cell_id, cellNumber: row.cell_number } : null,
  };
}

/** Находит заказ по идентификатору. */
function findById(id) {
  return mapRow(getDb().prepare(`${SELECT_ORDER} WHERE o.id = ?`).get(id));
}

/**
 * Находит заказ по трек-номеру.
 * Трек-номера хранятся в верхнем регистре, поэтому значение приводится к нему.
 */
function findByTrackNumber(trackNumber) {
  return mapRow(getDb()
    .prepare(`${SELECT_ORDER} WHERE o.track_number = ?`)
    .get(String(trackNumber).trim().toUpperCase()));
}

/**
 * Создаёт заказ, принятый в пункт выдачи: статус «Готов к выдаче»,
 * ячейка назначена, дата поступления — текущий момент.
 *
 * @param {{trackNumber: string, description?: string|null, userId: number, cellId: number}} data
 * @returns {object} созданный заказ
 */
function createReceived({ trackNumber, description = null, userId, cellId }) {
  const info = getDb()
    .prepare(
      `INSERT INTO Orders (track_number, description, user_id, cell_id, status, received_at)
       VALUES (?, ?, ?, ?, 'Готов к выдаче', datetime('now'))`,
    )
    .run(trackNumber, description, userId, cellId);

  return findById(info.lastInsertRowid);
}

/**
 * Принимает заказ, который уже был в системе со статусом «В пути»:
 * назначает ячейку, ставит дату поступления и статус «Готов к выдаче».
 *
 * Условие status = 'В пути' в запросе защищает от повторной приёмки:
 * если заказ уже принят, ни одна строка не изменится.
 *
 * @returns {object|null} принятый заказ либо null, если заказ уже не «В пути»
 */
function receiveInTransit({ id, cellId, description }) {
  const changes = getDb()
    .prepare(
      `UPDATE Orders
          SET status = 'Готов к выдаче',
              cell_id = ?,
              received_at = datetime('now'),
              description = COALESCE(?, description)
        WHERE id = ? AND status = 'В пути'`,
    )
    .run(cellId, description ?? null, id).changes;

  return changes > 0 ? findById(id) : null;
}

/**
 * Отмечает заказ выданным (18-й день): статус «Выдан», дата выдачи —
 * текущий момент. Ячейка остаётся записанной в заказе как история:
 * видно, из какой ячейки заказ был выдан.
 *
 * Условие status = 'Готов к выдаче' защищает от двойной выдачи:
 * если заказ уже выдан (например, вторым нажатием), строка не изменится.
 *
 * @returns {boolean} true, если заказ переведён в «Выдан»
 */
function markIssued(id) {
  return getDb()
    .prepare(
      `UPDATE Orders
          SET status = 'Выдан', issued_at = datetime('now')
        WHERE id = ? AND status = 'Готов к выдаче'`,
    )
    .run(id).changes > 0;
}

/**
 * Создаёт ожидаемый заказ со статусом «В пути» (20-й день): посылка
 * зарегистрирована, но ещё не поступила — ячейки и даты поступления нет.
 */
function createInTransit({ trackNumber, description = null, userId }) {
  const info = getDb()
    .prepare(`INSERT INTO Orders (track_number, description, user_id, status)
              VALUES (?, ?, ?, 'В пути')`)
    .run(trackNumber, description, userId);
  return findById(info.lastInsertRowid);
}

/**
 * Изменяет трек-номер, описание и получателя заказа (20-й день).
 * Передаются только изменяемые поля.
 */
function update(id, { trackNumber, description, userId }) {
  const sets = [];
  const params = { id };
  if (trackNumber !== undefined) { sets.push('track_number = @trackNumber'); params.trackNumber = trackNumber; }
  if (description !== undefined) { sets.push('description = @description'); params.description = description; }
  if (userId !== undefined) { sets.push('user_id = @userId'); params.userId = userId; }
  if (sets.length > 0) {
    getDb().prepare(`UPDATE Orders SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  return findById(id);
}

/**
 * Удаляет заказ. Если заказ лежал в ячейке, триггер базы данных
 * trg_orders_free_cell_on_delete (1-й день) освобождает ячейку.
 * @returns {boolean} true, если запись удалена
 */
function remove(id) {
  return getDb().prepare('DELETE FROM Orders WHERE id = ?').run(id).changes > 0;
}

/** Количество заказов пользователя, ожидающих выдачи (лежат в ячейках). */
function countReadyByUser(userId) {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM Orders WHERE user_id = ? AND status = 'Готов к выдаче'")
    .get(userId).n;
}

/** Общее количество заказов (используется в проверках). */
function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM Orders').get().n;
}

/**
 * Поля сортировки списка и соответствующие им выражения SQL.
 *
 * Имя поля из запроса никогда не подставляется в SQL напрямую: берётся
 * только готовое выражение из этой таблицы, поэтому внедрить свой код
 * через параметр сортировки невозможно.
 */
const SORT_COLUMNS = {
  receivedAt: 'o.received_at',
  issuedAt: 'o.issued_at',
  trackNumber: 'o.track_number',
  status: "CASE o.status WHEN 'В пути' THEN 1 WHEN 'Готов к выдаче' THEN 2 ELSE 3 END",
  cell: 'c.cell_number',
  client: 'u.name COLLATE NOCASE',
};

/**
 * Список заказов с фильтрацией и сортировкой (16-й день).
 *
 * @param {{
 *   userId?: number,       только заказы этого клиента («Мои заказы»)
 *   status?: string,       только заказы с этим статусом
 *   search?: string,       часть трек-номера, описания, имени или адреса клиента
 *   sort?: string,         ключ из SORT_COLUMNS
 *   order?: 'asc'|'desc'   направление сортировки
 * }} [filters]
 * @returns {object[]}
 */
function findMany({ userId, status, search, sort = 'receivedAt', order = 'desc' } = {}) {
  const conditions = [];
  const params = {};

  if (userId !== undefined) {
    conditions.push('o.user_id = @userId');
    params.userId = userId;
  }
  if (status) {
    conditions.push('o.status = @status');
    params.status = status;
  }
  if (search) {
    // Регистр не учитывается и для кириллицы (функция lower_ru, см. connection.js);
    // знаки % и _ в запросе ищутся как обычные символы
    conditions.push(`(lower_ru(o.track_number) LIKE @search ESCAPE '\\'
      OR lower_ru(o.description) LIKE @search ESCAPE '\\'
      OR lower_ru(u.name) LIKE @search ESCAPE '\\'
      OR lower_ru(u.email) LIKE @search ESCAPE '\\')`);
    params.search = `%${String(search).toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const column = SORT_COLUMNS[sort] || SORT_COLUMNS.receivedAt;
  const direction = order === 'asc' ? 'ASC' : 'DESC';

  // Пустые значения (заказ «В пути» без даты поступления) всегда в конце
  // списка, при равенстве — более новый заказ выше
  const sql = `${SELECT_ORDER}
    ${where}
    ORDER BY ${column} IS NULL, ${column} ${direction}, o.id DESC`;

  return getDb().prepare(sql).all(params).map(mapRow);
}

/**
 * Количество заказов по статусам — для счётчиков на вкладках фильтра.
 * @param {{userId?: number}} [filters]
 * @returns {{all: number, inTransit: number, ready: number, issued: number}}
 */
function countByStatus({ userId } = {}) {
  const where = userId !== undefined ? 'WHERE user_id = @userId' : '';
  const row = getDb().prepare(
    `SELECT COUNT(*) AS all_count,
            COALESCE(SUM(status = 'В пути'), 0)         AS in_transit,
            COALESCE(SUM(status = 'Готов к выдаче'), 0) AS ready,
            COALESCE(SUM(status = 'Выдан'), 0)          AS issued
       FROM Orders ${where}`,
  ).get(userId !== undefined ? { userId } : {});

  return { all: row.all_count, inTransit: row.in_transit, ready: row.ready, issued: row.issued };
}

module.exports = {
  findById,
  findByTrackNumber,
  createReceived,
  receiveInTransit,
  markIssued,
  createInTransit,
  update,
  remove,
  countReadyByUser,
  count,
  findMany,
  countByStatus,
  SORT_COLUMNS,
};
