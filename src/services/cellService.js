'use strict';

/**
 * Управление ячейками хранения.
 *
 * Ячейки — справочник адресного хранения на складе пункта выдачи. Просмотр
 * списка доступен всем авторизованным пользователям (клиенту нужно видеть,
 * свободна ли ячейка), а изменение справочника — только администратору.
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const cellRepository = require('../repositories/cellRepository');
const { getDb } = require('../db/connection');

/** Максимальный номер ячейки: ограничение, чтобы избежать случайных значений. */
const MAX_CELL_NUMBER = 999;

/** Допустимые состояния ячейки. */
const CELL_STATUSES = ['Свободна', 'Занята'];

/**
 * Проверяет идентификатор ячейки из адреса запроса.
 *
 * Без проверки запрос /api/cells/abc превращался в поиск ячейки с номером NaN
 * и возвращал непонятное сообщение «ячейка NaN не найдена».
 *
 * @param {string|number} raw значение из адреса
 * @returns {number} идентификатор
 * @throws {AppError} 400 — идентификатор не является целым положительным числом
 */
function parseCellId(raw) {
  const text = String(raw ?? '').trim();
  const id = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest('Идентификатор ячейки должен быть целым положительным числом', {
      id: { code: 'INVALID', message: 'Укажите целое положительное число' },
    });
  }
  return id;
}

/**
 * Сводка по состоянию склада.
 *
 * Все показатели считаются одним запросом к базе данных, поэтому они
 * согласованы между собой: сумма свободных и занятых всегда равна общему числу.
 *
 * @returns {{total: number, free: number, busy: number, occupancyPercent: number,
 *            firstFreeNumber: number|null, generatedAt: string}}
 */
function getSummary() {
  const counts = cellRepository.getCounts();

  return {
    total: counts.total,
    free: counts.free,
    busy: counts.busy,
    // Заполненность склада в процентах — удобно для отображения
    occupancyPercent: counts.total > 0 ? Math.round((counts.busy / counts.total) * 100) : 0,
    // Номер первой свободной ячейки: именно она будет назначена заказу
    // при автоматическом выборе (13-й день)
    firstFreeNumber: counts.firstFreeNumber,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Возвращает список ячеек со сводкой по состоянию.
 *
 * @param {{status?: string, withOrders?: boolean}} [options]
 *   status — фильтр по состоянию («Свободна» или «Занята»);
 *   withOrders — добавить сведения о занимающих ячейку заказах.
 * @returns {{cells: object[], summary: object}}
 */
function listCells({ status, withOrders = false } = {}) {
  let cells = withOrders ? cellRepository.findAllWithOrders() : cellRepository.findAll();

  if (status) {
    if (!CELL_STATUSES.includes(status)) {
      throw AppError.badRequest(
        `Недопустимое значение фильтра состояния: «${status}». `
        + `Допустимые значения: ${CELL_STATUSES.join(', ')}.`,
        { status: { code: 'NOT_ALLOWED', message: 'Допустимые значения: Свободна, Занята' } },
      );
    }
    cells = cells.filter((cell) => cell.status === status);
  }

  return { cells, summary: getSummary() };
}

/**
 * Возвращает только свободные ячейки, отсортированные по номеру.
 *
 * Используется при приёмке заказа: администратор выбирает ячейку
 * из этого списка, а при автоматическом выборе берётся первая из них.
 *
 * @returns {{cells: object[], count: number, firstFreeNumber: number|null}}
 */
function listFreeCells() {
  const cells = cellRepository.findFree();

  return {
    cells,
    count: cells.length,
    firstFreeNumber: cells.length > 0 ? cells[0].cellNumber : null,
  };
}

/**
 * Возвращает сведения об одной ячейке.
 *
 * @param {number} id
 * @param {{withOrder?: boolean}} [options] withOrder — добавить сведения
 *   о заказе, который лежит в ячейке (только для администратора)
 * @returns {object}
 * @throws {AppError} 404 — ячейка не найдена
 */
function getCell(id, { withOrder = false } = {}) {
  const cell = cellRepository.findById(id);
  if (!cell) throw AppError.notFound(`Ячейка с идентификатором ${id} не найдена`);

  if (!withOrder) return cell;

  return { ...cell, order: cellRepository.findActiveOrder(id) };
}

/**
 * Добавляет ячейку в справочник (только администратор).
 *
 * Номер ячейки можно не указывать — тогда берётся следующий за наибольшим.
 *
 * @param {{cellNumber?: number}} payload
 * @returns {object} созданная ячейка
 * @throws {AppError} 400 — номер задан неверно; 409 — ячейка с таким номером есть
 */
function addCell({ cellNumber } = {}) {
  let number = cellNumber;

  if (number === undefined || number === null || number === '') {
    number = cellRepository.getMaxCellNumber() + 1;
  } else {
    number = Number.parseInt(number, 10);
    if (!Number.isInteger(number) || number <= 0) {
      throw AppError.badRequest('Номер ячейки должен быть целым положительным числом', {
        cellNumber: { code: 'INVALID', message: 'Укажите целое положительное число' },
      });
    }
    if (number > MAX_CELL_NUMBER) {
      throw AppError.badRequest(`Номер ячейки не может превышать ${MAX_CELL_NUMBER}`, {
        cellNumber: { code: 'TOO_LARGE', message: `Не более ${MAX_CELL_NUMBER}` },
      });
    }
  }

  if (cellRepository.findByNumber(number)) {
    throw AppError.conflict(`Ячейка с номером ${number} уже существует`, {
      cellNumber: { code: 'ALREADY_EXISTS', message: `Ячейка с номером ${number} уже существует` },
    });
  }

  const cell = cellRepository.create(number);
  logger.info(`Администратор добавил ячейку номер ${number} (id=${cell.id})`);
  return cell;
}

/**
 * Изменяет состояние ячейки (только администратор).
 *
 * Обычно состояние меняется автоматически при приёмке и выдаче заказа;
 * ручное изменение нужно для исправления ошибок учёта.
 *
 * @param {number} id
 * @param {string} status
 * @returns {object} обновлённая ячейка
 * @throws {AppError} 400 — недопустимое состояние; 404 — ячейка не найдена;
 *                    409 — нельзя освободить ячейку с активным заказом
 */
function setCellStatus(id, status) {
  const cell = cellRepository.findById(id);
  if (!cell) throw AppError.notFound(`Ячейка с идентификатором ${id} не найдена`);

  if (!CELL_STATUSES.includes(status)) {
    throw AppError.badRequest(
      `Недопустимое состояние ячейки: «${status}». Допустимые значения: ${CELL_STATUSES.join(', ')}.`,
      { status: { code: 'NOT_ALLOWED', message: `Допустимые значения: ${CELL_STATUSES.join(', ')}` } },
    );
  }

  if (cell.status === status) {
    return cell;
  }

  // Ячейку с активным заказом нельзя перевести в состояние «Свободна»:
  // иначе заказ останется привязанным к свободной ячейке
  if (status === 'Свободна') {
    const activeOrder = getDb()
      .prepare("SELECT id, track_number FROM Orders WHERE cell_id = ? AND status = 'Готов к выдаче'")
      .get(id);

    if (activeOrder) {
      throw AppError.conflict(
        `Ячейка занята заказом ${activeOrder.track_number}. Сначала оформите выдачу заказа.`,
        { status: { code: 'CELL_BUSY', message: 'В ячейке находится активный заказ' } },
      );
    }
  }

  const updated = cellRepository.updateStatus(id, status);
  logger.info(`Состояние ячейки ${cell.cellNumber} изменено на «${status}»`);
  return updated;
}

/**
 * Удаляет ячейку из справочника (только администратор).
 *
 * @param {number} id
 * @throws {AppError} 404 — ячейка не найдена;
 *                    409 — на ячейку ссылаются заказы
 */
function deleteCell(id) {
  const cell = cellRepository.findById(id);
  if (!cell) throw AppError.notFound(`Ячейка с идентификатором ${id} не найдена`);

  // Проверяем ссылки до удаления, чтобы дать понятное сообщение
  // вместо технической ошибки ограничения внешнего ключа
  const linked = getDb()
    .prepare('SELECT COUNT(*) AS n FROM Orders WHERE cell_id = ?')
    .get(id).n;

  if (linked > 0) {
    throw AppError.conflict(
      `Невозможно удалить ячейку ${cell.cellNumber}: с ней связано заказов — ${linked}.`,
      { cellNumber: { code: 'HAS_ORDERS', message: `Связанных заказов: ${linked}` } },
    );
  }

  cellRepository.remove(id);
  logger.info(`Администратор удалил ячейку номер ${cell.cellNumber}`);
}

module.exports = {
  listCells,
  listFreeCells,
  getSummary,
  getCell,
  parseCellId,
  addCell,
  setCellStatus,
  deleteCell,
  MAX_CELL_NUMBER,
  CELL_STATUSES,
};
