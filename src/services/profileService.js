'use strict';

/**
 * Профиль пользователя (20-й день практики): изменение имени и удаление
 * учётной записи.
 *
 * Правила удаления:
 *   • пользователь подтверждает удаление своим паролем;
 *   • нельзя удалить учётную запись, пока в ячейках лежат её заказы
 *     «Готов к выдаче»: посылки физически находятся в пункте выдачи;
 *   • нельзя удалить последнего администратора — иначе некому будет
 *     принимать и выдавать заказы.
 *
 * При удалении сессии и заказы пользователя удаляются каскадно
 * (внешние ключи ON DELETE CASCADE в схеме базы данных).
 */

const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { transaction } = require('../db/connection');
const { verifyPassword } = require('../utils/password');
const { validate, required, length } = require('../validators/rules');
const userRepository = require('../repositories/userRepository');
const orderRepository = require('../repositories/orderRepository');

/** Схема изменения профиля: те же правила имени, что при регистрации. */
const profileSchema = {
  name: {
    label: 'Имя',
    rules: [required('Имя'), length({ min: 2, max: 100, label: 'Имя' })],
  },
};

/**
 * Изменяет имя пользователя.
 * @param {number} userId
 * @param {{name: string}} payload
 * @returns {object} данные пользователя без пароля
 */
function updateProfile(userId, payload = {}) {
  const data = validate(payload, profileSchema);
  const user = userRepository.updateName(userId, data.name);
  if (!user) throw AppError.notFound('Пользователь не найден');

  logger.info(`Пользователь id=${userId} изменил имя на «${data.name}»`);
  return userRepository.toPublic(user);
}

/**
 * Проверяет, можно ли удалить учётную запись.
 * @throws {AppError} 409 HAS_ACTIVE_ORDERS или LAST_ADMIN
 */
function assertCanDelete(user) {
  const ready = orderRepository.countReadyByUser(user.id);
  if (ready > 0) {
    throw new AppError(
      `Удалить учётную запись нельзя: в пункте выдачи ожидают получения заказов — ${ready}. `
        + 'Сначала заберите их или попросите администратора выдать.',
      409, 'HAS_ACTIVE_ORDERS',
    );
  }
  if (user.role === 'admin' && userRepository.countAdmins() <= 1) {
    throw new AppError('Нельзя удалить единственного администратора пункта выдачи', 409, 'LAST_ADMIN');
  }
}

/**
 * Удаляет собственную учётную запись после проверки пароля.
 * @param {number} userId
 * @param {{password: string}} payload
 */
async function deleteOwnAccount(userId, payload = {}) {
  const user = userRepository.findById(userId);
  if (!user) throw AppError.notFound('Пользователь не найден');

  const password = String(payload.password ?? '');
  if (password === '') {
    throw AppError.badRequest('Введите пароль, чтобы подтвердить удаление', {
      password: { code: 'REQUIRED', message: 'Введите пароль' },
    });
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new AppError('Пароль указан неверно', 401, 'INVALID_PASSWORD', {
      password: { code: 'INVALID_PASSWORD', message: 'Пароль указан неверно' },
    });
  }

  return removeUser(user);
}

/**
 * Удаление учётной записи клиента администратором.
 * @param {number} userId кого удалить
 * @param {{id: number}} admin кто удаляет
 */
function deleteUserByAdmin(userId, admin) {
  const user = userRepository.findById(userId);
  if (!user) throw AppError.notFound(`Пользователь с идентификатором ${userId} не найден`);
  if (user.id === admin.id) {
    throw AppError.badRequest('Свою учётную запись удалите на странице профиля');
  }
  return removeUser(user, admin.id);
}

/** Удаляет пользователя после проверок; всё в одной транзакции. */
function removeUser(user, adminId) {
  return transaction(() => {
    assertCanDelete(user);
    userRepository.remove(user.id);
    logger.info(`Удалена учётная запись ${user.email} (id=${user.id})`
      + `${adminId ? `, администратор id=${adminId}` : ''}`);
    return userRepository.toPublic(user);
  });
}

module.exports = {
  updateProfile,
  deleteOwnAccount,
  deleteUserByAdmin,
  assertCanDelete,
};
