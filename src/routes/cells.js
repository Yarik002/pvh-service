'use strict';

/**
 * Маршруты управления ячейками хранения: /api/cells
 *
 * Разграничение прав доступа:
 *   • просмотр ячеек — любой авторизованный пользователь
 *     (клиенту нужно видеть, есть ли свободные ячейки);
 *   • сведения о заказах в ячейках (трек-номер, получатель) — только
 *     администратор: клиент не должен видеть чужие заказы;
 *   • добавление, изменение состояния и удаление ячеек — только администратор.
 *
 * Проверка прав выполняется middleware requireAuth() и requireRole('admin')
 * из модуля src/middleware/authenticate.js. При попытке клиента обратиться
 * к административному маршруту возвращается ошибка 403 Forbidden.
 *
 * Порядок маршрутов важен: адреса /free, /summary и /suggest объявлены раньше /:id,
 * иначе слово «free» было бы принято за идентификатор ячейки.
 */

const express = require('express');

const cellService = require('../services/cellService');
const cellAssignment = require('../services/cellAssignment');
const { requireAuth, requireRole } = require('../middleware/authenticate');

const router = express.Router();

/**
 * Состояние ячеек меняется при каждой приёмке и выдаче заказа, поэтому
 * ответы раздела не кешируются браузером: пользователь всегда видит
 * актуальное состояние склада.
 */
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/** Признак администратора: ему доступны сведения о заказах в ячейках. */
function isAdmin(req) {
  return req.user?.role === 'admin';
}

/**
 * GET /api/cells
 * Список ячеек хранения со сводкой по состоянию.
 *
 * Доступ: любой авторизованный пользователь.
 *
 * Параметры запроса:
 *   status      — фильтр состояния: «Свободна» или «Занята»;
 *   free        — «true» — вернуть только свободные ячейки;
 *   withOrders  — «true», чтобы добавить трек-номера заказов в ячейках
 *                 (учитывается только для администратора).
 *
 * Ответ 200:
 *   {
 *     "success": true,
 *     "cells": [ { "id": 1, "cellNumber": 1, "status": "Свободна" }, … ],
 *     "summary": { "total": 20, "free": 18, "busy": 2, "occupancyPercent": 10,
 *                  "firstFreeNumber": 1, "generatedAt": "…" }
 *   }
 */
router.get('/', requireAuth(), (req, res, next) => {
  try {
    const onlyFree = String(req.query.free || '').toLowerCase() === 'true';
    const wantsOrders = String(req.query.withOrders || '').toLowerCase() === 'true';

    const { cells, summary } = cellService.listCells({
      status: onlyFree ? 'Свободна' : req.query.status,
      // Клиент не должен видеть трек-номера чужих заказов
      withOrders: wantsOrders && isAdmin(req),
    });

    res.status(200).json({
      success: true,
      cells,
      summary,
      filter: {
        status: onlyFree ? 'Свободна' : (req.query.status || null),
        onlyFree,
        withOrders: wantsOrders && isAdmin(req),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cells/free
 * Только свободные ячейки, отсортированные по номеру.
 *
 * Доступ: любой авторизованный пользователь.
 *
 * Ответ 200:
 *   { "success": true, "cells": [ … ], "count": 18, "firstFreeNumber": 3 }
 *
 * Если свободных ячеек нет, возвращается пустой список и
 * firstFreeNumber = null — это не ошибка, а состояние склада.
 */
router.get('/free', requireAuth(), (req, res, next) => {
  try {
    const { cells, count, firstFreeNumber } = cellService.listFreeCells();

    res.status(200).json({
      success: true,
      cells,
      count,
      firstFreeNumber,
      message: count > 0
        ? `Свободных ячеек: ${count}. Первая свободная — № ${firstFreeNumber}.`
        : 'Свободных ячеек нет.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cells/summary
 * Сводка по складу без списка ячеек: удобна для показателей на страницах.
 *
 * Доступ: любой авторизованный пользователь.
 */
router.get('/summary', requireAuth(), (req, res, next) => {
  try {
    res.status(200).json({ success: true, summary: cellService.getSummary() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cells/suggest
 * Предварительный выбор ячейки для заказа: какая ячейка будет назначена.
 * Ячейка при этом НЕ занимается — это делает приёмка заказа (14-й день).
 *
 * Доступ: только администратор (выбор ячейки — часть приёмки заказа).
 *
 * Параметры запроса:
 *   mode       — auto (первая свободная, по умолчанию) или manual;
 *   cellId     — идентификатор ячейки для ручного выбора;
 *   cellNumber — номер ячейки для ручного выбора.
 *
 * Ответы:
 *   200 — ячейка найдена: { mode, cell, message };
 *   400 — неверный способ выбора или ячейка не указана;
 *   404 — выбранной ячейки нет;
 *   409 — выбранная ячейка занята (CELL_BUSY) или свободных нет (NO_FREE_CELLS).
 */
router.get('/suggest', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const choice = cellAssignment.chooseCell({
      mode: req.query.mode,
      cellId: req.query.cellId,
      cellNumber: req.query.cellNumber,
    });

    res.status(200).json({ success: true, ...choice });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cells/:id
 * Сведения об одной ячейке.
 *
 * Доступ: любой авторизованный пользователь. Администратор дополнительно
 * получает сведения о заказе, который лежит в ячейке (поле order).
 *
 * Ответы: 200 — ячейка найдена; 400 — неверный идентификатор; 404 — нет ячейки.
 */
router.get('/:id', requireAuth(), (req, res, next) => {
  try {
    const cell = cellService.getCell(cellService.parseCellId(req.params.id), {
      withOrder: isAdmin(req),
    });

    res.status(200).json({ success: true, cell });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cells
 * Добавление ячейки в справочник.
 *
 * Доступ: только администратор (иначе 403 Forbidden).
 * Тело запроса: { "cellNumber": 21 } — номер можно не указывать.
 * Ответ 201:
 *   { "success": true, "message": "…", "cell": { … } }
 */
router.post('/', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const cell = cellService.addCell(req.body || {});

    res.status(201).json({
      success: true,
      message: `Ячейка номер ${cell.cellNumber} добавлена.`,
      cell,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/cells/:id/status
 * Изменение состояния ячейки.
 *
 * Доступ: только администратор (иначе 403 Forbidden).
 * Тело запроса: { "status": "Свободна" | "Занята" }
 * Ответ 200: { "success": true, "message": "…", "cell": { … } }
 */
router.patch('/:id/status', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const cell = cellService.setCellStatus(
      cellService.parseCellId(req.params.id),
      req.body?.status,
    );

    res.status(200).json({
      success: true,
      message: `Состояние ячейки ${cell.cellNumber}: «${cell.status}».`,
      cell,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/cells/:id
 * Удаление ячейки из справочника.
 *
 * Доступ: только администратор (иначе 403 Forbidden).
 * Ответ 200: { "success": true, "message": "…" }
 */
router.delete('/:id', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const id = cellService.parseCellId(req.params.id);
    cellService.deleteCell(id);

    res.status(200).json({
      success: true,
      message: `Ячейка с идентификатором ${id} удалена.`,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
