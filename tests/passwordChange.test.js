'use strict';

/**
 * Модульные тесты смены пароля (4-й день практики).
 *
 * Сервис проверяется напрямую, на отдельной базе данных в памяти.
 *
 * Запуск:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.LOG_LEVEL = 'error';

const { getDb, closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const authService = require('../src/services/authService');
const passwordService = require('../src/services/passwordService');
const userRepository = require('../src/repositories/userRepository');
const AppError = require('../src/utils/AppError');
const { verifyPassword } = require('../src/utils/password');

/** Готовит чистую схему базы данных перед каждым тестом. */
function prepareDatabase() {
  runMigrations();
  getDb().exec('DELETE FROM Orders; DELETE FROM Users;');
}

/** Создаёт пользователя и возвращает его запись. */
async function createUser(overrides = {}) {
  const { user } = await authService.register({
    name: 'Иванов Иван',
    email: 'ivanov@mail.ru',
    password: 'Xk9#mQ2$vL7p',
    passwordConfirm: 'Xk9#mQ2$vL7p',
    ...overrides,
  });
  return user;
}

test('смена пароля обновляет хеш в базе данных', async () => {
  prepareDatabase();
  const user = await createUser();

  const before = userRepository.findById(user.id).passwordHash;
  await passwordService.changePassword(user.id, {
    currentPassword: 'Xk9#mQ2$vL7p',
    newPassword: 'Tr9$kLm2#nQ',
    newPasswordConfirm: 'Tr9$kLm2#nQ',
  });

  const after = userRepository.findById(user.id).passwordHash;
  assert.notEqual(before, after, 'хеш должен измениться');
  assert.equal(await verifyPassword('Tr9$kLm2#nQ', after), true, 'новый пароль должен подходить');
  assert.equal(await verifyPassword('Xk9#mQ2$vL7p', after), false, 'старый пароль больше не подходит');
});

test('смена пароля заполняет дату изменения', async () => {
  prepareDatabase();
  const user = await createUser();

  assert.equal(userRepository.findById(user.id).passwordChangedAt, undefined);

  await passwordService.changePassword(user.id, {
    currentPassword: 'Xk9#mQ2$vL7p',
    newPassword: 'Tr9$kLm2#nQ',
    newPasswordConfirm: 'Tr9$kLm2#nQ',
  });

  const row = getDb().prepare('SELECT password_changed_at FROM Users WHERE id = ?').get(user.id);
  assert.ok(row.password_changed_at, 'дата смены пароля должна быть заполнена');
});

test('неверный текущий пароль отклоняется с кодом 401', async () => {
  prepareDatabase();
  const user = await createUser();

  await assert.rejects(
    () => passwordService.changePassword(user.id, {
      currentPassword: 'NevernyjParol1',
      newPassword: 'Tr9$kLm2#nQ',
      newPasswordConfirm: 'Tr9$kLm2#nQ',
    }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'INVALID_CURRENT_PASSWORD');
      return true;
    },
  );

  const hash = userRepository.findById(user.id).passwordHash;
  assert.equal(await verifyPassword('Xk9#mQ2$vL7p', hash), true, 'пароль не должен измениться');
});

test('несуществующий пользователь — ошибка 404', async () => {
  prepareDatabase();

  await assert.rejects(
    () => passwordService.changePassword(9999, {
      currentPassword: 'Xk9#mQ2$vL7p',
      newPassword: 'Tr9$kLm2#nQ',
      newPasswordConfirm: 'Tr9$kLm2#nQ',
    }),
    (error) => error.status === 404,
  );
});

test('новый пароль не должен совпадать с текущим', async () => {
  prepareDatabase();
  const user = await createUser();

  await assert.rejects(
    () => passwordService.changePassword(user.id, {
      currentPassword: 'Xk9#mQ2$vL7p',
      newPassword: 'Xk9#mQ2$vL7p',
      newPasswordConfirm: 'Xk9#mQ2$vL7p',
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details.newPassword.code, 'NOT_DIFFERENT');
      return true;
    },
  );
});

test('ненадёжный новый пароль отклоняется', async () => {
  prepareDatabase();
  const user = await createUser();

  const weak = [
    ['qwerty123', 'COMMON_PASSWORD'],
    ['password1', 'COMMON_PASSWORD'],
    ['ivanov2026', 'CONTAINS_PERSONAL_DATA'],
    ['abcabcabc1', 'REPEATED_PATTERN'],
    ['aaaabbbb1', 'REPEATED_PATTERN'],
  ];

  for (const [newPassword, expectedCode] of weak) {
    await assert.rejects(
      () => passwordService.changePassword(user.id, {
        currentPassword: 'Xk9#mQ2$vL7p',
        newPassword,
        newPasswordConfirm: newPassword,
      }),
      (error) => {
        assert.equal(error.status, 400, `пароль «${newPassword}» должен отклоняться`);
        assert.equal(error.details.newPassword.code, expectedCode,
          `пароль «${newPassword}»: ожидался код ${expectedCode}`);
        return true;
      },
    );
  }

  const hash = userRepository.findById(user.id).passwordHash;
  assert.equal(await verifyPassword('Xk9#mQ2$vL7p', hash), true, 'пароль не должен измениться');
});

test('подтверждение нового пароля проверяется', async () => {
  prepareDatabase();
  const user = await createUser();

  await assert.rejects(
    () => passwordService.changePassword(user.id, {
      currentPassword: 'Xk9#mQ2$vL7p',
      newPassword: 'Tr9$kLm2#nQ',
      newPasswordConfirm: 'Drug0jParol#1',
    }),
    (error) => {
      assert.equal(error.details.newPasswordConfirm.code, 'MISMATCH');
      return true;
    },
  );
});

test('смена пароля не возвращает хеш пароля клиенту', async () => {
  prepareDatabase();
  const user = await createUser();

  const { user: updated } = await passwordService.changePassword(user.id, {
    currentPassword: 'Xk9#mQ2$vL7p',
    newPassword: 'Tr9$kLm2#nQ',
    newPasswordConfirm: 'Tr9$kLm2#nQ',
  });

  assert.equal(updated.passwordHash, undefined, 'хеш не должен возвращаться');
  assert.equal(updated.confirmToken, undefined, 'токен не должен возвращаться');
  assert.equal(updated.email, 'ivanov@mail.ru');
});

test('пароль можно сменить несколько раз подряд', async () => {
  prepareDatabase();
  const user = await createUser();

  const passwords = ['Tr9$kLm2#nQ', 'Wq5%zR8&mK3', 'Bn7!xT4@vD9'];
  let current = 'Xk9#mQ2$vL7p';

  for (const next of passwords) {
    await passwordService.changePassword(user.id, {
      currentPassword: current,
      newPassword: next,
      newPasswordConfirm: next,
    });
    const hash = userRepository.findById(user.id).passwordHash;
    assert.equal(await verifyPassword(next, hash), true, `пароль «${next}» должен подходить`);
    assert.equal(await verifyPassword(current, hash), false, 'предыдущий пароль не должен подходить');
    current = next;
  }
});

test('проверка надёжности возвращает оценку и перечень проверок', () => {
  const result = passwordService.checkStrength('Xk9#mQ2$vL7p', {
    name: 'Иванов Иван',
    email: 'ivanov@mail.ru',
  });

  assert.equal(typeof result.score, 'number');
  assert.ok(result.checks.length > 0);
  assert.ok(result.label.length > 0);
  assert.equal(result.warnings.length, 0);
});

test('проверка надёжности отклоняет пустой запрос', () => {
  assert.throws(() => passwordService.checkStrength(''), AppError);
  assert.throws(() => passwordService.checkStrength(undefined), AppError);
  assert.throws(() => passwordService.checkStrength('a'.repeat(201)), AppError);
});

test('завершение работы: соединение с базой данных закрывается', () => {
  closeDb();
});
