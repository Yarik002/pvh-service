'use strict';

/**
 * Маршруты управления ячейками хранения: /api/cells
 *
 * Разграничение прав доступа:
 *   • просмотр списка ячеек — любой авторизованный пользователь
 *     (клиенту нужно видеть, есть ли свободные ячейки);
 *   • добавление, изменение состояния и удаление ячеек — только администратор.
 *
 * Проверка прав выполняется middleware requireAuth() и requireRole('admin')
 * из модуля src/middleware/authenticate.js. При попытке клиента обратиться
 * к административному маршруту возвращается ошибка 403 Forbidden.
 */

const express = require('express');

const cellService = require('../services/cellService');
const { requireAuth, requireRole } = require('../middleware/authenticate');

const router = express.Router();

/**
 * GET /api/cells
 * Список ячеек хранения со сводкой по состоянию.
 *
 * Доступ: любой авторизованный пользователь.
 *
 * Параметры запроса:
 *   status      — фильтр состояния: «Свободна» или «Занята»;
 *   withOrders  — «true», чтобы добавить сведения о занимающих ячейку заказах;
 *   free        — «true» — вернуть только свободные ячейки.
 *
 * Ответ 200:
 *   {
 *     "success": true,
 *     "cells": [ { "id": 1, "cellNumber": 1, "status": "Свободна" }, … ],
 *     "summary": { "total": 20, "free": 18, "busy": 2, "occupancyPercent": 10 }
 *   }
 */
router.get('/', requireAuth(), (req, res, next) => {
  try {
    const onlyFree = String(req.query.free || '').toLowerCase() === 'true';

    const { cells, summary } = cellService.listCells({
      status: onlyFree ? 'Свободна' : req.query.status,
      withOrders: String(req.query.withOrders || '').toLowerCase() === 'true',
    });

    res.status(200).json({
      success: true,
      cells,
      summary,
      filter: {
        status: onlyFree ? 'Свободна' : (req.query.status || null),
        onlyFree,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cells/:id
 * Сведения об одной ячейке.
 * Доступ: любой авторизованный пользователь.
 */
router.get('/:id', requireAuth(), (req, res, next) => {
  try {
    const cell = cellService.getCell(Number.parseInt(req.params.id, 10));

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
      Number.parseInt(req.params.id, 10),
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
    cellService.deleteCell(Number.parseInt(req.params.id, 10));

    res.status(200).json({
      success: true,
      message: `Ячейка с идентификатором ${req.params.id} удалена.`,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
