'use strict';

/**
 * Маршруты заказов: /api/orders
 *
 *   GET  /api/orders     — «Все заказы» с фильтрами (только администратор);
 *   GET  /api/orders/my  — «Мои заказы» с фильтрами (текущий пользователь);
 *   POST /api/orders     — приёмка заказа в пункт выдачи (только администратор);
 *   GET  /api/orders/:id — сведения о заказе (администратор — любой заказ,
 *                          клиент — только свой);
 *   POST /api/orders/:id/issue — выдача заказа (только администратор, 18-й день);
 *   POST   /api/orders/expected — ожидаемый заказ «В пути» (администратор, 20-й день);
 *   PATCH  /api/orders/:id      — изменение заказа (администратор, 20-й день);
 *   DELETE /api/orders/:id      — удаление заказа (администратор, 20-й день).
 *
 * Параметры списков (16-й день), все необязательные:
 *   status — В пути | Готов к выдаче | Выдан (или transit | ready | issued, all);
 *   search — часть трек-номера, описания, имени или адреса клиента;
 *   sort   — receivedAt (по умолчанию) | issuedAt | trackNumber | status | cell
 *            | client (только «Все заказы»);
 *   order  — desc (по умолчанию) | asc;
 *   clientId — заказы одного клиента (только «Все заказы»).
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

/** Ответ со списком заказов: сами заказы, счётчики по статусам и фильтры. */
function sendList(res, { orders, counts, filters }) {
  res.status(200).json({
    success: true,
    orders,
    total: orders.length,
    counts,
    filters,
  });
}

/**
 * GET /api/orders/my
 * «Мои заказы»: заказы текущего пользователя с фильтрацией и сортировкой.
 *
 * Ответы:
 *   200 — { orders, total, counts: {all, inTransit, ready, issued}, filters };
 *   400 — недопустимое значение параметра (код BAD_FILTER);
 *   401 — пользователь не вошёл в систему.
 */
router.get('/my', requireAuth(), (req, res, next) => {
  try {
    sendList(res, orderService.listMyOrders(req.query, req.user));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/orders
 * «Все заказы»: заказы всех клиентов (только администратор).
 *
 * Ответы: как у /api/orders/my, плюс 403 для клиента.
 */
router.get('/', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    sendList(res, orderService.listAllOrders(req.query));
  } catch (error) {
    next(error);
  }
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
 * POST /api/orders/expected
 * Ожидаемый заказ: посылка зарегистрирована со статусом «В пути»,
 * ячейка назначится при приёмке. Тело: trackNumber, clientEmail или clientId,
 * description. Ответы: 201, 400, 404, 409 (трек-номер уже есть).
 */
router.post('/expected', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const order = orderService.createExpectedOrder(req.body || {});
    res.status(201).json({
      success: true,
      message: `Заказ ${order.trackNumber} зарегистрирован со статусом «В пути».`,
      order,
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

/**
 * PATCH /api/orders/:id
 * Изменение заказа: trackNumber, description, clientEmail (или clientId).
 * Ответы: 200, 400, 404, 409 (заказ выдан или трек-номер занят).
 */
router.patch('/:id', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const order = orderService.updateOrder(orderService.parseOrderId(req.params.id), req.body || {});
    res.status(200).json({ success: true, message: `Заказ ${order.trackNumber} изменён.`, order });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/orders/:id
 * Удаление заказа. Ячейка заказа «Готов к выдаче» освобождается.
 * Ответы: 200 { order, freedCell }, 404.
 */
router.delete('/:id', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const { order, freedCell } = orderService.deleteOrder(orderService.parseOrderId(req.params.id));
    res.status(200).json({
      success: true,
      message: `Заказ ${order.trackNumber} удалён`
        + (freedCell ? `, ячейка № ${freedCell.cellNumber} свободна.` : '.'),
      order,
      freedCell,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/orders/:id/issue
 * Выдача заказа: статус «Выдан» и освобождение ячейки в одной транзакции.
 *
 * Доступ: только администратор.
 *
 * Ответы:
 *   200 — заказ выдан: { order, cell, message };
 *   400 — идентификатор не число;
 *   404 — заказ не найден;
 *   409 — заказ уже выдан (ORDER_ALREADY_ISSUED) или ещё в пути (ORDER_NOT_READY).
 */
router.post('/:id/issue', requireAuth(), requireRole('admin'), (req, res, next) => {
  try {
    const { order, cell } = orderService.issueOrder(
      orderService.parseOrderId(req.params.id),
      { adminId: req.user.id },
    );

    res.status(200).json({
      success: true,
      message: `Заказ ${order.trackNumber} выдан клиенту, ячейка № ${cell.cellNumber} свободна.`,
      order,
      cell,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
