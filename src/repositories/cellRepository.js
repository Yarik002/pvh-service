'use strict';

/**
 * Доступ к данным ячеек хранения (таблица Storage_Cells).
 *
 * Все запросы к справочнику ячеек собраны в этом модуле.
 */

const { getDb } = require('../db/connection');

/** Приводит строку базы данных к удобному для клиента виду. */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    cellNumber: row.cell_number,
    status: row.status,
    // Дополнительные сведения, если запрос их запрашивает
    orderId: row.order_id ?? undefined,
    trackNumber: row.track_number ?? undefined,
  };
}

/** Возвращает все ячейки, отсортированные по номеру. */
function findAll() {
  return getDb()
    .prepare('SELECT id, cell_number, status FROM Storage_Cells ORDER BY cell_number')
    .all()
    .map(mapRow);
}

/**
 * Возвращает свободные ячейки, отсортированные по номеру.
 * Используется при назначении ячейки заказу (13-й день).
 */
function findFree() {
  return getDb()
    .prepare("SELECT id, cell_number, status FROM Storage_Cells WHERE status = 'Свободна' ORDER BY cell_number")
    .all()
    .map(mapRow);
}

/** Находит ячейку по идентификатору. */
function findById(id) {
  const row = getDb()
    .prepare('SELECT id, cell_number, status FROM Storage_Cells WHERE id = ?')
    .get(id);
  return mapRow(row);
}

/** Находит ячейку по номеру. */
function findByNumber(cellNumber) {
  const row = getDb()
    .prepare('SELECT id, cell_number, status FROM Storage_Cells WHERE cell_number = ?')
    .get(cellNumber);
  return mapRow(row);
}

/**
 * Возвращает ячейки вместе со сведениями о занимающих их заказах.
 * Используется администратором для наглядного списка (15-й день).
 */
function findAllWithOrders() {
  return getDb()
    .prepare(
      `SELECT c.id, c.cell_number, c.status,
              o.id AS order_id, o.track_number
         FROM Storage_Cells c
         LEFT JOIN Orders o
                ON o.cell_id = c.id
               AND o.status = 'Готов к выдаче'
        ORDER BY c.cell_number`,
    )
    .all()
    .map(mapRow);
}

/**
 * Создаёт ячейку.
 * @param {number} cellNumber номер ячейки
 * @returns {object|null} созданная запись
 */
function create(cellNumber) {
  const info = getDb()
    .prepare('INSERT INTO Storage_Cells (cell_number, status) VALUES (?, \'Свободна\')')
    .run(cellNumber);
  return findById(info.lastInsertRowid);
}

/**
 * Изменяет состояние ячейки.
 * @param {number} id
 * @param {'Свободна'|'Занята'} status
 * @returns {object|null}
 */
function updateStatus(id, status) {
  getDb().prepare('UPDATE Storage_Cells SET status = ? WHERE id = ?').run(status, id);
  return findById(id);
}

/**
 * Удаляет ячейку.
 * Ограничение внешнего ключа не позволит удалить ячейку, на которую ссылается
 * заказ, — репозиторий сообщает об этом вызывающему коду.
 *
 * @param {number} id
 * @returns {boolean} true, если запись удалена
 */
function remove(id) {
  return getDb().prepare('DELETE FROM Storage_Cells WHERE id = ?').run(id).changes > 0;
}

/** Возвращает количество ячеек с указанным состоянием. */
function countByStatus(status) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM Storage_Cells WHERE status = ?')
    .get(status).n;
}

/** Возвращает общее количество ячеек. */
function count() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM Storage_Cells').get().n;
}

/**
 * Возвращает наибольший номер ячейки.
 * Используется при создании следующей ячейки и в сценарии начальной настройки.
 */
function getMaxCellNumber() {
  return getDb().prepare('SELECT COALESCE(MAX(cell_number), 0) AS n FROM Storage_Cells').get().n;
}

module.exports = {
  findAll,
  findFree,
  findById,
  findByNumber,
  findAllWithOrders,
  create,
  updateStatus,
  remove,
  countByStatus,
  count,
  getMaxCellNumber,
};
