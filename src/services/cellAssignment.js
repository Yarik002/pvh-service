'use strict';

/**
 * Алгоритм назначения ячейки хранения заказу (13-й день практики).
 *
 * Требование ТЗ (п. 3.6): ячейка выбирается из ячеек со статусом
 * «Свободна» — автоматически либо вручную администратором — после чего
 * её статус меняется на «Занята».
 *
 * Два режима выбора:
 *   auto   — первая свободная ячейка по номеру (не по идентификатору:
 *            номер — это то, что написано на ячейке на складе);
 *   manual — ячейка, выбранная администратором по идентификатору
 *            или номеру; проверяется, что она существует и свободна.
 *
 * Модуль разделяет выбор и занятие ячейки:
 *   chooseCell() — только находит подходящую ячейку и ничего не меняет
 *                  (используется для предварительного просмотра в интерфейсе);
 *   occupyCell() — занимает ячейку одним условным запросом UPDATE … WHERE
 *                  status = 'Свободна', поэтому одну ячейку нельзя занять дважды;
 *   assignCell() — выбор и занятие в одной транзакции (используется
 *                  при приёмке заказа на 14-м дне).
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const cellRepository = require('../repositories/cellRepository');
const { getDb, transaction } = require('../db/connection');

/** Режимы выбора ячейки. */
const ASSIGN_MODES = {
  AUTO: 'auto',
  MANUAL: 'manual',
};

/** Коды отказов: по ним интерфейс выбирает, что показать администратору. */
const ASSIGN_ERRORS = {
  INVALID_MODE: 'INVALID_ASSIGN_MODE',
  CELL_REQUIRED: 'CELL_REQUIRED',
  INVALID_CELL: 'INVALID_CELL',
  CELL_NOT_FOUND: 'CELL_NOT_FOUND',
  CELL_BUSY: 'CELL_BUSY',
  NO_FREE_CELLS: 'NO_FREE_CELLS',
};

/**
 * Приводит значение к целому положительному числу либо возвращает null.
 * @param {*} value
 * @returns {number|null}
 */
function toPositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return Number.NaN;
  const number = Number.parseInt(text, 10);
  return number > 0 && Number.isSafeInteger(number) ? number : Number.NaN;
}

/**
 * Автоматический выбор: первая свободная ячейка по номеру.
 * @returns {object} ячейка
 * @throws {AppError} 409 NO_FREE_CELLS — свободных ячеек нет
 */
function chooseAutomatically() {
  const [first] = cellRepository.findFree();

  if (!first) {
    const total = cellRepository.count();
    const message = total === 0
      ? 'В справочнике нет ни одной ячейки хранения. Добавьте ячейки, чтобы принимать заказы.'
      : `Свободных ячеек нет: все ${total} ячеек заняты. Выдайте один из заказов `
        + 'или добавьте ячейку в справочник.';

    throw new AppError(message, 409, ASSIGN_ERRORS.NO_FREE_CELLS, {
      cell: { code: ASSIGN_ERRORS.NO_FREE_CELLS, message },
    });
  }

  return first;
}

/**
 * Ручной выбор: ячейка, указанная администратором.
 *
 * @param {{cellId?: *, cellNumber?: *}} choice идентификатор или номер ячейки
 * @returns {object} ячейка
 * @throws {AppError} 400 — ячейка не указана или указана неверно;
 *                    404 — ячейка не найдена; 409 — ячейка занята
 */
function chooseManually({ cellId, cellNumber } = {}) {
  const id = toPositiveInt(cellId);
  const number = toPositiveInt(cellNumber);

  if (id === null && number === null) {
    throw new AppError('Выберите ячейку хранения из списка свободных', 400, ASSIGN_ERRORS.CELL_REQUIRED, {
      cell: { code: ASSIGN_ERRORS.CELL_REQUIRED, message: 'Выберите ячейку' },
    });
  }

  if (Number.isNaN(id) || Number.isNaN(number)) {
    throw new AppError('Ячейка указана неверно: ожидается целое положительное число', 400,
      ASSIGN_ERRORS.INVALID_CELL, {
        cell: { code: ASSIGN_ERRORS.INVALID_CELL, message: 'Укажите целое положительное число' },
      });
  }

  const cell = id !== null ? cellRepository.findById(id) : cellRepository.findByNumber(number);

  if (!cell) {
    const label = id !== null ? `с идентификатором ${id}` : `№ ${number}`;
    throw new AppError(`Ячейка ${label} не найдена`, 404, ASSIGN_ERRORS.CELL_NOT_FOUND, {
      cell: { code: ASSIGN_ERRORS.CELL_NOT_FOUND, message: 'Такой ячейки нет в справочнике' },
    });
  }

  if (cell.status !== 'Свободна') {
    // Подсказываем администратору, какую ячейку можно выбрать вместо занятой
    const [firstFree] = cellRepository.findFree();
    const hint = firstFree
      ? ` Ближайшая свободная — № ${firstFree.cellNumber}.`
      : ' Свободных ячеек нет.';

    throw new AppError(`Ячейка № ${cell.cellNumber} занята.${hint}`, 409, ASSIGN_ERRORS.CELL_BUSY, {
      cell: {
        code: ASSIGN_ERRORS.CELL_BUSY,
        message: `Ячейка № ${cell.cellNumber} занята`,
        suggestedCellNumber: firstFree ? firstFree.cellNumber : null,
      },
    });
  }

  return cell;
}

/**
 * Выбирает ячейку, ничего не изменяя в базе данных.
 *
 * @param {{mode?: string, cellId?: *, cellNumber?: *}} [options]
 *   mode — 'auto' (по умолчанию) или 'manual';
 *   cellId / cellNumber — ячейка для ручного выбора.
 * @returns {{mode: string, cell: object, message: string}}
 * @throws {AppError} см. chooseAutomatically() и chooseManually()
 */
function chooseCell({ mode = ASSIGN_MODES.AUTO, cellId, cellNumber } = {}) {
  const normalizedMode = String(mode || ASSIGN_MODES.AUTO).trim().toLowerCase();

  if (normalizedMode === ASSIGN_MODES.AUTO) {
    const cell = chooseAutomatically();
    return {
      mode: ASSIGN_MODES.AUTO,
      cell,
      message: `Будет назначена ячейка № ${cell.cellNumber} — первая свободная.`,
    };
  }

  if (normalizedMode === ASSIGN_MODES.MANUAL) {
    const cell = chooseManually({ cellId, cellNumber });
    return {
      mode: ASSIGN_MODES.MANUAL,
      cell,
      message: `Будет назначена выбранная ячейка № ${cell.cellNumber}.`,
    };
  }

  throw new AppError('Способ выбора ячейки указан неверно: допустимо auto или manual', 400,
    ASSIGN_ERRORS.INVALID_MODE, {
      mode: { code: ASSIGN_ERRORS.INVALID_MODE, message: 'Допустимые значения: auto, manual' },
    });
}

/**
 * Занимает ячейку.
 *
 * Запрос меняет статус, только если ячейка всё ещё свободна. Если между
 * выбором и занятием ячейку занял другой администратор, запрос не изменит
 * ни одной строки, и будет возвращена ошибка 409 — одна ячейка не может
 * быть отдана двум заказам.
 *
 * @param {number} cellId идентификатор ячейки
 * @returns {object} занятая ячейка
 * @throws {AppError} 409 CELL_BUSY — ячейка уже занята
 */
function occupyCell(cellId) {
  const changes = getDb()
    .prepare("UPDATE Storage_Cells SET status = 'Занята' WHERE id = ? AND status = 'Свободна'")
    .run(cellId).changes;

  if (changes === 0) {
    const cell = cellRepository.findById(cellId);
    const label = cell ? `№ ${cell.cellNumber}` : `с идентификатором ${cellId}`;
    throw new AppError(`Ячейка ${label} уже занята другим заказом`, 409, ASSIGN_ERRORS.CELL_BUSY, {
      cell: { code: ASSIGN_ERRORS.CELL_BUSY, message: 'Ячейка уже занята' },
    });
  }

  return cellRepository.findById(cellId);
}

/**
 * Выбирает и занимает ячейку в одной транзакции.
 *
 * Если внешняя транзакция уже открыта (приёмка заказа), better-sqlite3
 * выполняет вложенную как точку сохранения: при ошибке откатывается
 * вся приёмка целиком.
 *
 * @param {{mode?: string, cellId?: *, cellNumber?: *}} [options]
 * @returns {{mode: string, cell: object, message: string}}
 */
function assignCell(options = {}) {
  return transaction(() => {
    const choice = chooseCell(options);
    const cell = occupyCell(choice.cell.id);

    logger.info(`Назначена ячейка № ${cell.cellNumber} (${choice.mode === 'auto' ? 'автоматически' : 'вручную'})`);

    return {
      mode: choice.mode,
      cell,
      message: `Назначена ячейка № ${cell.cellNumber}`
        + (choice.mode === ASSIGN_MODES.AUTO ? ' (первая свободная).' : ' (выбрана вручную).'),
    };
  });
}

module.exports = {
  chooseCell,
  occupyCell,
  assignCell,
  ASSIGN_MODES,
  ASSIGN_ERRORS,
};
