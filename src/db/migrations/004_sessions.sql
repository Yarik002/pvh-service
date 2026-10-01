-- =====================================================================
--  Миграция 004. Сессии пользователей.
--
--  Сессия — это право доступа к системе, выданное после успешного входа.
--  Клиент получает токен сессии и предъявляет его при каждом запросе
--  (в заголовке Authorization или в cookie).
--
--  В базе данных хранится не сам токен, а его хеш SHA-256. Это защищает
--  учётные записи в случае утечки базы данных: по сохранённому значению
--  нельзя восстановить токен и воспользоваться чужой сессией.
--
--  Поля:
--    token_hash   — хеш токена сессии (SHA-256, шестнадцатеричная строка);
--    user_id      — владелец сессии;
--    created_at   — дата и время создания сессии;
--    expires_at   — дата и время окончания сессии;
--    last_used_at — дата последнего обращения с этим токеном;
--    user_agent   — сведения о браузере клиента (для диагностики);
--    ip_address   — адрес клиента (для диагностики).
-- =====================================================================

CREATE TABLE IF NOT EXISTS Sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT    NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT    NOT NULL,
    last_used_at TEXT,
    user_agent   TEXT,
    ip_address   TEXT,

    FOREIGN KEY (user_id) REFERENCES Users (id)
        ON UPDATE CASCADE ON DELETE CASCADE
);

-- Поиск сессий пользователя (например, для завершения всех сессий)
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON Sessions (user_id);

-- Очистка истёкших сессий
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON Sessions (expires_at);
