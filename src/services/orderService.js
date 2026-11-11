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
const cellRepository = require('../repositories/cellRepository');
const mailer = require('../mail/mailer');

/** Коды отказов приёмки. */
const ORDER_ERRORS = {
  CLIENT_REQUIRED: 'CLIENT_REQUIRED',
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  NOT_A_CLIENT: 'NOT_A_CLIENT',
  TRACK_EXISTS: 'TRACK_EXISTS',
  TRACK_OTHER_CLIENT: 'TRACK_OTHER_CLIENT',
  ORDER_NOT_READY: 'ORDER_NOT_READY',
  ORDER_ALREADY_ISSUED: 'ORDER_ALREADY_ISSUED',
  ORDER_READONLY: 'ORDER_READONLY',
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

// ---------------------------------------------------------------------------
//  Выдача заказа (18-й день)
// ---------------------------------------------------------------------------

/**
 * Выдаёт заказ клиенту.
 *
 * В ОДНОЙ ТРАНЗАКЦИИ:
 *   1) заказ переводится из «Готов к выдаче» в «Выдан», ставится дата выдачи;
 *   2) ячейка, в которой лежал заказ, становится «Свободна».
 * Если любой шаг не удался, отменяются оба: не возникнет ни выданного заказа
 * с занятой ячейкой, ни свободной ячейки с невыданным заказом.
 *
 * @param {number} id идентификатор заказа
 * @param {{adminId?: number}} [context] кто выдал заказ (для журнала)
 * @returns {{order: object, cell: object}} выданный заказ и освобождённая ячейка
 * @throws {AppError} 404 — заказ не найден;
 *                    409 ORDER_ALREADY_ISSUED — заказ уже выдан;
 *                    409 ORDER_NOT_READY — заказ ещё в пути
 */
function issueOrder(id, context = {}) {
  const result = transaction(() => {
    const order = orderRepository.findById(id);
    if (!order) throw AppError.notFound(`Заказ с идентификатором ${id} не найден`);

    if (order.status === 'Выдан') {
      throw new AppError(`Заказ ${order.trackNumber} уже выдан клиенту`, 409, ORDER_ERRORS.ORDER_ALREADY_ISSUED);
    }
    if (order.status !== 'Готов к выдаче') {
      throw new AppError(`Заказ ${order.trackNumber} ещё не поступил в пункт выдачи (статус «${order.status}»)`,
        409, ORDER_ERRORS.ORDER_NOT_READY);
    }

    // Шаг 1. Статус «Выдан». Условие в запросе не даст выдать заказ дважды
    // при одновременных нажатиях
    if (!orderRepository.markIssued(id)) {
      throw new AppError(`Заказ ${order.trackNumber} уже выдан клиенту`, 409, ORDER_ERRORS.ORDER_ALREADY_ISSUED);
    }

    // Шаг 2. Освобождение ячейки
    const cell = cellRepository.updateStatus(order.cell.id, 'Свободна');

    return { order: orderRepository.findById(id), cell };
  });

  logger.info(`Выдан заказ ${result.order.trackNumber} клиенту ${result.order.client.email}: `
    + `ячейка № ${result.cell.cellNumber} освобождена`
    + `${context.adminId ? `, администратор id=${context.adminId}` : ''}`);

  return result;
}

// ---------------------------------------------------------------------------
//  Создание, изменение и удаление заказа (20-й день, CRUD)
// ---------------------------------------------------------------------------

/** Ошибка «трек-номер уже есть» у поля формы. */
function trackExists(trackNumber) {
  return new AppError(`Заказ с трек-номером ${trackNumber} уже есть в системе`, 409, ORDER_ERRORS.TRACK_EXISTS, {
    trackNumber: { code: ORDER_ERRORS.TRACK_EXISTS, message: 'Заказ с таким трек-номером уже есть' },
  });
}

/**
 * Регистрирует ожидаемый заказ со статусом «В пути»: посылка ещё в дороге,
 * ячейка будет назначена при приёмке (POST /api/orders с тем же трек-номером).
 *
 * @param {{trackNumber, clientId?, clientEmail?, description?}} payload
 * @returns {object} созданный заказ
 */
function createExpectedOrder(payload = {}) {
  const data = validate(payload, receiveOrderSchema);
  const client = resolveClient(payload);
  if (orderRepository.findByTrackNumber(data.trackNumber)) throw trackExists(data.trackNumber);

  try {
    const order = orderRepository.createInTransit({
      trackNumber: data.trackNumber,
      description: data.description === '' ? null : data.description,
      userId: client.id,
    });
    logger.info(`Зарегистрирован ожидаемый заказ ${order.trackNumber} для ${client.email}`);
    return order;
  } catch (error) {
    if (isTrackNumberConflict(error)) throw trackExists(data.trackNumber);
    throw error;
  }
}

/**
 * Изменяет заказ: трек-номер, описание, получателя.
 * Выданный заказ — история, его изменить нельзя.
 *
 * @param {number} id
 * @param {object} payload изменяемые поля (необязательные)
 * @returns {object} изменённый заказ
 * @throws {AppError} 404 — нет заказа; 409 — заказ выдан или трек-номер занят;
 *                    400 — поля заполнены неверно
 */
function updateOrder(id, payload = {}) {
  const order = orderRepository.findById(id);
  if (!order) throw AppError.notFound(`Заказ с идентификатором ${id} не найден`);
  if (order.status === 'Выдан') {
    throw new AppError(`Заказ ${order.trackNumber} уже выдан — изменить его нельзя`, 409, ORDER_ERRORS.ORDER_READONLY);
  }

  // Проверяются только переданные поля; незаполненные остаются прежними
  const changes = {};
  const data = validate({
    trackNumber: payload.trackNumber ?? order.trackNumber,
    description: payload.description ?? order.description ?? '',
  }, receiveOrderSchema);

  if (payload.trackNumber !== undefined && data.trackNumber !== order.trackNumber) {
    const other = orderRepository.findByTrackNumber(data.trackNumber);
    if (other && other.id !== id) throw trackExists(data.trackNumber);
    changes.trackNumber = data.trackNumber;
  }
  if (payload.description !== undefined) {
    changes.description = data.description === '' ? null : data.description;
  }
  const hasClient = ['clientId', 'clientEmail']
    .some((key) => payload[key] !== undefined && payload[key] !== null && String(payload[key]).trim() !== '');
  if (hasClient) {
    changes.userId = resolveClient(payload).id;
  }

  try {
    const updated = orderRepository.update(id, changes);
    logger.info(`Изменён заказ ${updated.trackNumber}: ${Object.keys(changes).join(', ') || 'без изменений'}`);
    return updated;
  } catch (error) {
    if (isTrackNumberConflict(error)) throw trackExists(changes.trackNumber);
    throw error;
  }
}

/**
 * Удаляет заказ. Если заказ лежал в ячейке, ячейка освобождается
 * (триггер базы данных), поэтому в ответе возвращается освобождённая ячейка.
 *
 * @param {number} id
 * @returns {{order: object, freedCell: object|null}}
 */
function deleteOrder(id) {
  return transaction(() => {
    const order = orderRepository.findById(id);
    if (!order) throw AppError.notFound(`Заказ с идентификатором ${id} не найден`);

    orderRepository.remove(id);
    const freedCell = order.status === 'Готов к выдаче' && order.cell
      ? cellRepository.findById(order.cell.id)
      : null;

    logger.info(`Удалён заказ ${order.trackNumber}`
      + `${freedCell ? `, ячейка № ${freedCell.cellNumber} освобождена` : ''}`);
    return { order, freedCell };
  });
}

// ---------------------------------------------------------------------------
//  Списки заказов (16-й день): «Мои заказы» и «Все заказы»
// ---------------------------------------------------------------------------

/** Статусы заказа в порядке жизненного цикла. */
const ORDER_STATUSES = ['В пути', 'Готов к выдаче', 'Выдан'];

/**
 * Короткие латинские обозначения статусов: их удобно передавать в адресе
 * (?status=ready), не кодируя кириллицу.
 */
const STATUS_ALIASES = {
  transit: 'В пути',
  ready: 'Готов к выдаче',
  issued: 'Выдан',
};

/** Направления сортировки. */
const SORT_ORDERS = ['asc', 'desc'];

/** Ошибка параметра списка: 400 с указанием параметра в details. */
function badFilter(field, message) {
  return new AppError(message, 400, 'BAD_FILTER', { [field]: { code: 'BAD_FILTER', message } });
}

/**
 * Проверяет и приводит к единому виду параметры списка из строки запроса.
 *
 * @param {object} query req.query
 * @param {{allowClientSort?: boolean}} [options] сортировка по клиенту есть
 *        только в списке «Все заказы»
 * @returns {{status: string|null, search: string, sort: string, order: string}}
 * @throws {AppError} 400 BAD_FILTER — недопустимое значение параметра
 */
function parseListQuery(query = {}, { allowClientSort = false } = {}) {
  // Статус: русское название, латинское обозначение или all / пусто — все заказы
  const rawStatus = String(query.status ?? '').trim();
  let status = null;
  if (rawStatus !== '' && rawStatus.toLowerCase() !== 'all') {
    status = STATUS_ALIASES[rawStatus.toLowerCase()]
      || ORDER_STATUSES.find((item) => item.toLowerCase() === rawStatus.toLowerCase())
      || null;
    if (!status) {
      throw badFilter('status', 'Недопустимый статус. Допустимые значения: '
        + `${ORDER_STATUSES.join(', ')} (или ${Object.keys(STATUS_ALIASES).join(', ')}, all)`);
    }
  }

  const search = String(query.search ?? query.q ?? '').trim();
  if ([...search].length > 100) {
    throw badFilter('search', 'Строка поиска должна содержать не более 100 символов');
  }

  const sortKeys = Object.keys(orderRepository.SORT_COLUMNS)
    .filter((key) => allowClientSort || key !== 'client');
  const sort = String(query.sort ?? '').trim() || 'receivedAt';
  if (!sortKeys.includes(sort)) {
    throw badFilter('sort', `Недопустимое поле сортировки. Допустимые значения: ${sortKeys.join(', ')}`);
  }

  const order = String(query.order ?? '').trim().toLowerCase() || 'desc';
  if (!SORT_ORDERS.includes(order)) {
    throw badFilter('order', 'Направление сортировки: asc (по возрастанию) или desc (по убыванию)');
  }

  return { status, search, sort, order };
}

/**
 * Список «Мои заказы»: только заказы текущего пользователя.
 * @param {object} query параметры из строки запроса
 * @param {{id: number}} user
 */
function listMyOrders(query, user) {
  const filters = parseListQuery(query);
  return {
    orders: orderRepository.findMany({ ...filters, userId: user.id }),
    counts: orderRepository.countByStatus({ userId: user.id }),
    filters,
  };
}

/**
 * Список «Все заказы» (администратор). Дополнительно можно отобрать
 * заказы одного клиента параметром clientId.
 * @param {object} query параметры из строки запроса
 */
function listAllOrders(query = {}) {
  const filters = parseListQuery(query, { allowClientSort: true });

  let userId;
  if (query.clientId !== undefined && String(query.clientId).trim() !== '') {
    const text = String(query.clientId).trim();
    userId = /^\d+$/.test(text) ? Number.parseInt(text, 10) : 0;
    if (!userId) throw badFilter('clientId', 'Идентификатор клиента должен быть целым положительным числом');
  }

  return {
    orders: orderRepository.findMany({ ...filters, userId }),
    counts: orderRepository.countByStatus({ userId }),
    filters: { ...filters, clientId: userId ?? null },
  };
}

module.exports = {
  receiveOrder,
  issueOrder,
  createExpectedOrder,
  updateOrder,
  deleteOrder,
  resolveClient,
  parseOrderId,
  getOrderForUser,
  parseListQuery,
  listMyOrders,
  listAllOrders,
  ORDER_ERRORS,
  ORDER_STATUSES,
  STATUS_ALIASES,
};
