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

/** Общее количество заказов (используется в проверках). */
function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM Orders').get().n;
}

module.exports = {
  findById,
  findByTrackNumber,
  createReceived,
  receiveInTransit,
  count,
};
