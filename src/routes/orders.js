'use strict';

/**
 * Маршруты заказов: /api/orders
 *
 *   POST /api/orders     — приёмка заказа в пункт выдачи (только администратор);
 *   GET  /api/orders/:id — сведения о заказе (администратор — любой заказ,
 *                          клиент — только свой).
 *
 * Списки «Мои заказы» и «Все заказы» с фильтрацией появятся на 16-м дне.
 */

const express = require('express');

const orderService = require('../services/orderService');
const { requireAuth, requireRole } = require('../middleware/authenticate');

const router = express.Router();

/** Состояние заказов меняется при приёмке и выдаче — ответы не кешируются. */
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/**
 * POST /api/orders
 * Приёмка заказа: назначение ячейки и сохранение заказа в одной транзакции.
 *
 * Доступ: только администратор.
 *
 * Тело запроса:
 *   {
 *     "trackNumber": "RA123456789BY",
 *     "clientEmail": "ivanov@mail.ru",      (или "clientId": 5)
 *     "description": "Книга, 0,5 кг",       (необязательно)
 *     "cellMode": "auto",                   (или "manual" + "cellNumber": 7)
 *   }
 *
 * Ответы:
 *   201 — заказ принят: заказ, ячейка, результат отправки письма;
 *   400 — поля заполнены неверно;
 *   404 — получатель или выбранная ячейка не найдены;
 *   409 — трек-номер уже принят, ячейка занята или свободных ячеек нет.
 */
router.post('/', requireAuth(), requireRole('admin'), async (req, res, next) => {
  try {
    const { order, assignment, notification, fromTransit } = await orderService.receiveOrder(
      req.body || {},
      { adminId: req.user.id },
    );

    res.status(201).json({
      success: true,
      message: `Заказ ${order.trackNumber} принят и размещён в ячейке № ${order.cell.cellNumber}.`,
      order,
      assignment,
      notification,
      fromTransit,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/orders/:id
 * Сведения о заказе: трек-номер, статус, ячейка, получатель, даты.
 */
router.get('/:id', requireAuth(), (req, res, next) => {
  try {
    const order = orderService.getOrderForUser(orderService.parseOrderId(req.params.id), req.user);
    res.status(200).json({ success: true, order });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
