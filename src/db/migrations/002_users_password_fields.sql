-- =====================================================================
--  Миграция 002. Дополнение таблицы Users для работы с паролями.
--
--  Добавляются поля:
--    password_changed_at  — дата и время последней смены пароля;
--    must_change_password — признак необходимости сменить пароль
--                           (например, при сбросе пароля администратором).
--
--  Значения по умолчанию выбраны так, чтобы существующие записи оставались
--  корректными: дата смены пароля не заполнена, принудительная смена выключена.
-- =====================================================================

ALTER TABLE Users ADD COLUMN password_changed_at TEXT;

ALTER TABLE Users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
    CHECK (must_change_password IN (0, 1));

-- Индекс для выборки пользователей с принудительной сменой пароля
CREATE INDEX IF NOT EXISTS idx_users_must_change_password
    ON Users (must_change_password)
    WHERE must_change_password = 1;
