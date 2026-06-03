// popup.js — version with background-tab open/wait/close and instant removal from UI
document.addEventListener("DOMContentLoaded", refresh);

const UNREAD_FILTER_URL = "https://e.mail.ru/search/?q_read=1";
const LAST_MESSAGES_KEY = "lastMessages";

// Стили перенесены в popup.css

// ---- Основное обновление списка ----
async function refresh() {
  try {
    const state = await send({ type: "getState" });

    const cache =
      state.cache || state.lastMessages || state.last_messages || {};
    const accounts = state.accounts || [];

    const list = document.getElementById("list");
    if (!list) {
      console.error("popup: элемент #list не найден в DOM");
      return;
    }
    list.innerHTML = "";

    if (!accounts.length) {
      list.innerHTML = `
	      <div class="empty">Аккаунт не найден. Введите email:</div>
	      <input type="text" id="manualEmail" placeholder="user@mail.ru">
	      <button id="saveEmail">Сохранить</button>
	    `;

      document
        .getElementById("saveEmail")
        .addEventListener("click", async () => {
          const email = document.getElementById("manualEmail").value.trim();
          if (email) {
            // Сохраняем напрямую, чтобы не потерялось
            await chrome.storage.local.set({ userEmail: email });

            // Дополнительно уведомляем background
            await send({ type: "addAccount", email });

            // Закрываем popup, чтобы при следующем открытии уже был список писем
            window.close();
          }
        });
      return;
    }

    for (const acc of accounts) {
      const email = typeof acc === "string" ? acc : acc.email || acc;
      if (!email) continue;

      const block = document.createElement("div");
      block.className = "acc";

      // Заголовок аккаунта: email | [Прочитать все] | [счётчик-линк]
      const title = document.createElement("div");
      title.className = "acc-title";

      const emailEl = document.createElement("span");
      emailEl.textContent = email;
      emailEl.className = "acc-email";

      let msgs = [];
      if (Array.isArray(cache[email])) msgs = cache[email].slice();
      else {
        const foundKey = Object.keys(cache).find(
          (k) => String(k).toLowerCase() === String(email).toLowerCase()
        );
        if (foundKey && Array.isArray(cache[foundKey]))
          msgs = cache[foundKey].slice();
        else msgs = [];
      }

      // Кнопка "Прочитать все"
      const readAllBtn = document.createElement("button");
      readAllBtn.textContent = "Прочитать все";
      readAllBtn.title = "Пометить все непрочитанные как прочитанные";
      readAllBtn.className = "read-all-btn";
      readAllBtn.disabled = !msgs.length;
      readAllBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!msgs.length) return;

        const prev = readAllBtn.textContent;
        readAllBtn.disabled = true;
        readAllBtn.textContent = "…";

        // оптимистично делаем все строки серыми сразу
        const rows = block.querySelectorAll(".msg-row");
        rows.forEach(r => r.classList.add("fading"));

        try {
          const res = await send({ type: "markRead", email });
          if (!res?.ok) throw new Error(res?.error || "markRead failed");
        } catch (e) {
          console.error("Ошибка markRead:", e);
          // rollback — убираем серость при ошибке
          rows.forEach(r => r.classList.remove("fading"));
          alert("Не удалось пометить все письма прочитанными.");
        } finally {
          readAllBtn.disabled = false;
          readAllBtn.textContent = prev;
          await refresh();
        }
      });

      // Счётчик непрочитанных — ссылка на фильтр
      const countEl = document.createElement("a");
      countEl.href = UNREAD_FILTER_URL;
      countEl.target = "_blank";
      countEl.rel = "noopener noreferrer";
      countEl.textContent = String(msgs.length || 0);
      countEl.title = "Открыть фильтр непрочитанных";
      countEl.setAttribute("aria-label", `${msgs.length} непрочитанных`);
      countEl.className = "count-link";

      title.appendChild(emailEl);
      title.appendChild(readAllBtn);
      title.appendChild(countEl);
      block.appendChild(title);

      // Письма
      if (!msgs.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Непрочитанных писем нет";
        block.appendChild(empty);
      } else {
        for (const m of msgs) {
          try {
            const row = document.createElement("div");
            row.className = "msg-row";

            // ---- 1) Точка (ОТДЕЛЬНО, НЕ В ССЫЛКЕ) ----
            const dot = document.createElement("span");
            dot.textContent = "•";
            dot.title = "Пометить как прочитанное";
            dot.className = "msg-dot";

            // обработчик клика ТОЛЬКО по точке
            dot.addEventListener("click", async (ev) => {
              ev.preventDefault();
              ev.stopPropagation();

              const id = composeId(m);
              if (!id) return;

              row.classList.add("fading"); // оптимистичное затухание

              try {
                const res = await send({
                  type: "markRead",
                  email,
                  href: m.link || buildMessageLink(m),
                  id,
                });

                if (!res?.ok) throw new Error(res?.error || "markRead failed");

                await refresh();
              } catch (e) {
                console.error("Ошибка пометки:", e);
                row.classList.remove("fading"); // rollback
                alert("Не удалось пометить письмо прочитанным");
              }
            });

            // ---- 2) Ссылка ТОЛЬКО на текст ----
            const link = document.createElement("a");
            link.href = m.link || buildMessageLink(m);
            link.target = "_blank";
            link.className = "msg-link";

            // ---- 3) Блок "от кого" ----
            const senderBlock = document.createElement("div");
            senderBlock.className = "msg-sender-block";

            const fromName = document.createElement("div");
            fromName.textContent = normalizeFrom(m);
            fromName.className = "msg-from-name";

            senderBlock.appendChild(fromName);

            // ---- 4) Тема ----
            const subj = document.createElement("div");
            subj.textContent = m.subject || m.subj || "(без темы)";
            subj.className = "msg-subj";

            // ---- сборка ----
            link.appendChild(senderBlock);
            link.appendChild(subj);

            row.appendChild(dot);
            row.appendChild(link);

            block.appendChild(row);
          } catch (e) {
            console.warn("Ошибка при рендере письма:", e);
          }
        }
      }

      list.appendChild(block);
    }
  } catch (e) {
    console.error("Ошибка в refresh():", e);
    const list = document.getElementById("list");
    if (list) list.innerHTML = `<div class="empty">Ошибка: ${String(e)}</div>`;
  }
}

// ✅ НОВАЯ ФУНКЦИЯ: ждём, пока кэш обновится
async function waitForCacheUpdate(email, oldCount, maxWait = 5000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    await new Promise((resolve) => setTimeout(resolve, 100));

    const state = await send({ type: "getState" });
    const cache =
      state.cache || state.lastMessages || state.last_messages || {};

    let currentMsgs = [];
    if (Array.isArray(cache[email])) {
      currentMsgs = cache[email];
    } else {
      const foundKey = Object.keys(cache).find(
        (k) => String(k).toLowerCase() === String(email).toLowerCase()
      );
      if (foundKey && Array.isArray(cache[foundKey])) {
        currentMsgs = cache[foundKey];
      }
    }

    // Если количество писем уменьшилось - обновление произошло
    if (currentMsgs.length < oldCount) {
      console.log(
        `Кэш обновлён: было ${oldCount}, стало ${currentMsgs.length}`
      );
      return true;
    }
  }

  console.warn("Таймаут ожидания обновления кэша");
  return false;
}

// ---- Вспомогательные функции ----
function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          console.error("chrome.runtime.lastError:", chrome.runtime.lastError);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || {});
        }
      });
    } catch (e) {
      console.error("send() error:", e);
      resolve({ ok: false, error: e.message });
    }
  });
}

// ----- normalizeFrom: под разные версии данных -----
function normalizeFrom(m) {
  const f = m.correspondents?.from?.[0] || m.from || m.sender;
  if (!f) return "";
  if (typeof f === "string") return f;
  const name = f.name || f.display_name || "";
  const mail = f.email || f.address || "";
  if (name && mail) return `${name} <${mail}>`;
  return mail || name || "";
}

// Прямая ссылка на письмо (fid/id)
function buildMessageLink(m) {
  const fid = String(m.fid ?? m.folder_id ?? m.folder ?? "5");
  const mid = m.id || m.mid || m.message_id || m.msgid || "";
  const direct = m.link || m.url || "";
  if (direct) return direct;
  if (mid && /:/.test(mid))
    return `https://e.mail.ru/${encodeURIComponent(fid)}/${encodeURIComponent(
      mid
    )}/`;
  if (mid)
    return `https://e.mail.ru/message/${encodeURIComponent(mid)}/?back=1`;
  return "https://e.mail.ru/";
}

// Составной ID для пометки (fid:id или как есть)
function composeId(m) {
  const fidRaw = m.fid ?? m.folder_id ?? m.folder ?? "";
  const fid = (fidRaw == null ? "" : String(fidRaw)).trim();
  const id = m.id || m.mid || m.message_id || m.msgid || "";
  const sid = String(id || "").trim();

  console.log("composeId вызван для:", { fid, id: sid, исходное: m });

  if (!sid) {
    console.warn("composeId: пустой ID письма");
    return "";
  }

  // Если ID уже содержит двоеточие - возвращаем как есть
  if (sid.includes(":")) {
    console.log("composeId результат (с двоеточием):", sid);
    return sid;
  }

  // Иначе формируем fid:id
  const result = fid ? `${fid}:${sid}` : sid;
  console.log("composeId результат:", result);
  return result;
}

// Применяем normalizeFrom ко всем письмам после загрузки (страховка кэша)
async function updateCache() {
  try {
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(LAST_MESSAGES_KEY, (res) => resolve(res || {}))
    );
    const cache = stored?.[LAST_MESSAGES_KEY] || {};
    for (const email in cache) {
      const msgs = cache[email] || [];
      for (const m of msgs) {
        try {
          m.from = normalizeFrom(m);
        } catch (_) {}
      }
    }
    try {
      await new Promise((resolve) =>
        chrome.storage.local.set({ [LAST_MESSAGES_KEY]: cache }, resolve)
      );
    } catch (e) {}
  } catch (e) {
    console.warn("updateCache error:", e);
  }
}

updateCache().then(refresh);
