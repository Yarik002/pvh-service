'use strict';

/**
 * Работа с заказами: приёмка заказа в пункт выдачи (14-й день практики).
 *
 * Порядок приёмки (требование ТЗ, п. 3.3 и 3.6):
 *   1) проверить трек-номер и описание посылки;
 *   2) найти получателя (клиента) по идентификатору или адресу почты;
 *   3) проверить, что заказ с таким трек-номером ещё не принят;
 *   4) В ОДНОЙ ТРАНЗАКЦИИ: назначить ячейку (алгоритм 13-го дня)
 *      и сохранить заказ со статусом «Готов к выдаче»;
 *   5) отправить клиенту письмо о поступлении заказа.
 *
 * Транзакция гарантирует, что не возникнет ни «занятой ячейки без заказа»,
 * ни «заказа без ячейки»: если любой шаг не удался, отменяются оба.
 *
 * Письмо отправляется после завершения транзакции. Ошибка отправки
 * не отменяет приёмку: посылка уже физически лежит в ячейке.
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { transaction } = require('../db/connection');
const { validate } = require('../validators/rules');
const { receiveOrderSchema } = require('../validators/schemas');
const userRepository = require('../repositories/userRepository');
const orderRepository = require('../repositories/orderRepository');
const cellAssignment = require('./cellAssignment');
const mailer = require('../mail/mailer');

/** Коды отказов приёмки. */
const ORDER_ERRORS = {
  CLIENT_REQUIRED: 'CLIENT_REQUIRED',
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  NOT_A_CLIENT: 'NOT_A_CLIENT',
  TRACK_EXISTS: 'TRACK_EXISTS',
  TRACK_OTHER_CLIENT: 'TRACK_OTHER_CLIENT',
};

/**
 * Находит получателя заказа.
 *
 * Получатель указывается идентификатором (clientId — при выборе из списка)
 * либо адресом электронной почты (clientEmail — при вводе вручную).
 *
 * @param {{clientId?: *, clientEmail?: *}} payload
 * @returns {object} запись пользователя
 * @throws {AppError} 400 — получатель не указан или не является клиентом;
 *                    404 — получатель не найден
 */
function resolveClient({ clientId, clientEmail } = {}) {
  const hasId = clientId !== undefined && clientId !== null && String(clientId).trim() !== '';
  const hasEmail = typeof clientEmail === 'string' && clientEmail.trim() !== '';

  if (!hasId && !hasEmail) {
    throw new AppError('Укажите получателя заказа', 400, ORDER_ERRORS.CLIENT_REQUIRED, {
      client: { code: ORDER_ERRORS.CLIENT_REQUIRED, message: 'Выберите клиента из списка или укажите его адрес' },
    });
  }

  let client = null;
  if (hasId) {
    const id = /^\d+$/.test(String(clientId).trim()) ? Number.parseInt(clientId, 10) : null;
    client = id ? userRepository.findById(id) : null;
  } else {
    client = userRepository.findByEmail(clientEmail);
  }

  if (!client) {
    throw new AppError('Получатель не найден: клиент должен быть зарегистрирован в системе', 404,
      ORDER_ERRORS.CLIENT_NOT_FOUND, {
        client: { code: ORDER_ERRORS.CLIENT_NOT_FOUND, message: 'Клиент не найден' },
      });
  }

  if (client.role !== 'client') {
    throw new AppError('Получателем заказа может быть только клиент', 400, ORDER_ERRORS.NOT_A_CLIENT, {
      client: { code: ORDER_ERRORS.NOT_A_CLIENT, message: 'Выбранный пользователь не является клиентом' },
    });
  }

  return client;
}

/**
 * Проверяет, можно ли принять заказ с таким трек-номером.
 *
 * Заказ мог появиться в системе заранее со статусом «В пути» — тогда
 * приёмка переводит его в «Готов к выдаче». Уже принятый или выданный
 * заказ повторно принять нельзя.
 *
 * @returns {object|null} заказ «В пути» с этим трек-номером либо null
 * @throws {AppError} 409 — заказ уже принят, выдан или принадлежит другому клиенту
 */
function checkTrackNumber(trackNumber, client) {
  const existing = orderRepository.findByTrackNumber(trackNumber);
  if (!existing) return null;

  if (existing.status !== 'В пути') {
    const where = existing.status === 'Выдан'
      ? 'уже выдан клиенту'
      : `уже принят и лежит в ячейке № ${existing.cell?.cellNumber}`;

    throw new AppError(`Заказ ${trackNumber} ${where}`, 409, ORDER_ERRORS.TRACK_EXISTS, {
      trackNumber: { code: ORDER_ERRORS.TRACK_EXISTS, message: 'Заказ с таким трек-номером уже принят' },
    });
  }

  if (existing.client.id !== client.id) {
    throw new AppError(`Заказ ${trackNumber} оформлен на другого клиента`, 409,
      ORDER_ERRORS.TRACK_OTHER_CLIENT, {
        client: { code: ORDER_ERRORS.TRACK_OTHER_CLIENT, message: 'Заказ оформлен на другого клиента' },
      });
  }

  return existing;
}

/** Ошибка уникальности трек-номера от SQLite (одновременная приёмка). */
function isTrackNumberConflict(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE' && /track_number/.test(error.message);
}

/**
 * Отправляет клиенту письмо о поступлении заказа.
 * Никогда не выбрасывает исключение: приёмка уже выполнена.
 */
async function notifyClient(order) {
  try {
    const delivery = await mailer.sendOrderReceivedEmail({
      name: order.client.name,
      email: order.client.email,
      trackNumber: order.trackNumber,
      cellNumber: order.cell.cellNumber,
      description: order.description,
    });

    return {
      sent: delivery.status === 'sent',
      logged: delivery.status === 'logged',
      status: delivery.status,
      error: delivery.error,
    };
  } catch (error) {
    logger.error(`Не удалось отправить письмо о заказе ${order.trackNumber}:`, error);
    return { sent: false, logged: false, status: 'failed', error: error.message };
  }
}

/**
 * Принимает заказ в пункт выдачи.
 *
 * @param {object} payload данные формы приёмки:
 *   trackNumber — трек-номер (обязательно);
 *   clientId или clientEmail — получатель (обязательно одно из двух);
 *   description — описание посылки (необязательно, до 500 символов);
 *   cellMode — 'auto' (по умолчанию) или 'manual';
 *   cellId / cellNumber — ячейка при ручном выборе.
 * @param {{adminId?: number}} [context] кто принял заказ (для журнала)
 * @returns {Promise<{order: object, assignment: object, notification: object,
 *                    fromTransit: boolean}>}
 * @throws {AppError} 400, 404, 409 — см. описание полей и ORDER_ERRORS,
 *                    а также отказы алгоритма назначения ячейки
 */
async function receiveOrder(payload = {}, context = {}) {
  // Шаг 1. Трек-номер и описание
  const data = validate(payload, receiveOrderSchema);
  const description = data.description === '' ? null : data.description;

  // Шаг 2. Получатель
  const client = resolveClient(payload);

  // Шаг 3. Трек-номер ещё не принят
  const inTransit = checkTrackNumber(data.trackNumber, client);

  // Шаг 4. Назначение ячейки и сохранение заказа — одна транзакция
  let result;
  try {
    result = transaction(() => {
      const assignment = cellAssignment.assignCell({
        mode: payload.cellMode,
        cellId: payload.cellId,
        cellNumber: payload.cellNumber,
      });

      const order = inTransit
        ? orderRepository.receiveInTransit({ id: inTransit.id, cellId: assignment.cell.id, description })
        : orderRepository.createReceived({
          trackNumber: data.trackNumber,
          description,
          userId: client.id,
          cellId: assignment.cell.id,
        });

      if (!order) {
        // Заказ «В пути» успели принять одновременно с нами
        throw new AppError(`Заказ ${data.trackNumber} уже принят`, 409, ORDER_ERRORS.TRACK_EXISTS);
      }

      return { order, assignment };
    });
  } catch (error) {
    if (isTrackNumberConflict(error)) {
      throw new AppError(`Заказ ${data.trackNumber} уже принят`, 409, ORDER_ERRORS.TRACK_EXISTS, {
        trackNumber: { code: ORDER_ERRORS.TRACK_EXISTS, message: 'Заказ с таким трек-номером уже принят' },
      });
    }
    throw error;
  }

  logger.info(
    `Принят заказ ${result.order.trackNumber} для ${client.email}: ячейка № ${result.order.cell.cellNumber}`
    + `${context.adminId ? `, администратор id=${context.adminId}` : ''}`,
  );

  // Шаг 5. Письмо клиенту (после фиксации транзакции)
  const notification = await notifyClient(result.order);

  return {
    order: result.order,
    assignment: { mode: result.assignment.mode, message: result.assignment.message },
    notification,
    fromTransit: Boolean(inTransit),
  };
}

/**
 * Проверяет идентификатор заказа из адреса запроса.
 * @throws {AppError} 400 — не целое положительное число
 */
function parseOrderId(raw) {
  const text = String(raw ?? '').trim();
  const id = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest('Идентификатор заказа должен быть целым положительным числом');
  }
  return id;
}

/**
 * Возвращает заказ с учётом прав: администратор видит любой заказ,
 * клиент — только свой. Чужой заказ для клиента «не существует» (404),
 * чтобы по ответу нельзя было узнать, есть ли такой заказ.
 *
 * @param {number} id
 * @param {{id: number, role: string}} user
 * @throws {AppError} 404 — заказ не найден или недоступен
 */
function getOrderForUser(id, user) {
  const order = orderRepository.findById(id);

  if (!order || (user.role !== 'admin' && order.client.id !== user.id)) {
    throw AppError.notFound(`Заказ с идентификатором ${id} не найден`);
  }
  return order;
}

module.exports = {
  receiveOrder,
  resolveClient,
  parseOrderId,
  getOrderForUser,
  ORDER_ERRORS,
};
