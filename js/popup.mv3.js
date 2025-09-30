// popup.js — version with background-tab open/wait/close and instant removal from UI
document.addEventListener("DOMContentLoaded", refresh);

const UNREAD_FILTER_URL = "https://e.mail.ru/search/?q_read=1";
const LAST_MESSAGES_KEY = "lastMessages";

document.body.style.minWidth = "600px";

// ---- Основное обновление списка ----
async function refresh() {
  try {
    const state = await send({ type: "getState" });

    const cache = state.cache || state.lastMessages || state.last_messages || {};
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
	      <input type="text" id="manualEmail" placeholder="user@mail.ru" style="width: 90%; margin: 4px 0;">
	      <button id="saveEmail">Сохранить</button>
	    `;
	
	   document.getElementById("saveEmail").addEventListener("click", async () => {
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
      const email = (typeof acc === "string") ? acc : (acc.email || acc);
      if (!email) continue;

      const block = document.createElement("div");
      block.className = "acc";

      // Заголовок аккаунта: email | [Прочитать все] | [счётчик-линк]
      const title = document.createElement("div");
      title.style.display = "flex";
      title.style.alignItems = "center";
      title.style.gap = "8px";
      title.style.marginBottom = "6px";

      const emailEl = document.createElement("span");
      emailEl.textContent = email;
      emailEl.style.fontWeight = "600";

      let msgs = [];
      if (Array.isArray(cache[email])) msgs = cache[email].slice();
      else {
        const foundKey = Object.keys(cache).find(k => String(k).toLowerCase() === String(email).toLowerCase());
        if (foundKey && Array.isArray(cache[foundKey])) msgs = cache[foundKey].slice();
        else msgs = [];
      }

      // Кнопка "Прочитать все"
      const readAllBtn = document.createElement("button");
      readAllBtn.textContent = "Прочитать все";
      readAllBtn.title = "Пометить все непрочитанные как прочитанные";
      readAllBtn.style.padding = "4px 8px";
      readAllBtn.style.borderRadius = "8px";
      readAllBtn.disabled = !msgs.length;
      readAllBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!msgs.length) return;
        const ids = msgs.map(composeId).filter(Boolean);
        if (!ids.length) return;

        const prev = readAllBtn.textContent;
        readAllBtn.disabled = true;
        readAllBtn.textContent = "…";
        try {
          const res = await send({ type: "markRead", email, id: ids });
          if (!res?.ok) throw new Error(res?.error || "markRead failed");
        } catch (e) {
          console.error(e);
          alert("Не удалось пометить все письма прочитанными.");
        } finally {
          readAllBtn.disabled = true;
          readAllBtn.textContent = prev;
          await refresh();
        }
      });

      // Счётчик непрочитанных — ссылка на фильтр
      const countEl = document.createElement('a');
      countEl.href = UNREAD_FILTER_URL;
      countEl.target = '_blank';
      countEl.rel = 'noopener noreferrer';
      countEl.textContent = String(msgs.length || 0);
      countEl.title = "Открыть фильтр непрочитанных";
      countEl.setAttribute('aria-label', `${msgs.length} непрочитанных`);

      countEl.style.setProperty('display', 'inline-flex', 'important');
      countEl.style.setProperty('align-items', 'center', 'important');
      countEl.style.setProperty('justify-content', 'center', 'important');
      countEl.style.setProperty('min-width', '30px', 'important');
      countEl.style.setProperty('height', '30px', 'important');
      countEl.style.setProperty('padding', '0 8px', 'important');
      countEl.style.setProperty('border-radius', '999px', 'important');
      countEl.style.setProperty('background', '#000', 'important');
      countEl.style.setProperty('color', '#fff', 'important');
      countEl.style.setProperty('font-weight', '700', 'important');
      countEl.style.setProperty('font-size', '14px', 'important');
      countEl.style.setProperty('text-decoration', 'none', 'important');
      countEl.style.setProperty('margin-left', 'auto', 'important');
      countEl.style.setProperty('cursor', 'pointer', 'important');

      title.appendChild(emailEl);
      //title.appendChild(readAllBtn);
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
            const rowLink = document.createElement("a");
            rowLink.href = m.link || buildMessageLink(m);
            rowLink.target = "_blank";
            rowLink.style.display = "grid";
			//rowLink.style.gridTemplateColumns = "10px minmax(0, 33%) 1fr"; // точка | блок "от кого" макс 1/3 | тема
			rowLink.style.gridTemplateColumns = "minmax(0, 33%) 1fr"; //  блок "от кого" макс 1/3 | тема
            rowLink.style.alignItems = "center";
            rowLink.style.gap = "10px";
            rowLink.style.margin = "6px 0";
            rowLink.style.textDecoration = "none";
            rowLink.style.color = "inherit";

            // ---- 1) Точка ----
            //const dot = document.createElement("span");
            //dot.textContent = "•";
            //dot.title = "Непрочитанное письмо";
            //dot.style.fontSize = "18px";
            //dot.style.lineHeight = "1";

            // ---- 2) Блок "от кого" ----
            const senderBlock = document.createElement("div");
            senderBlock.style.display = "flex";
            senderBlock.style.flexDirection = "column";
            senderBlock.style.whiteSpace = "normal";
            senderBlock.style.overflow = "visible";

            const fromName = document.createElement("div");
            fromName.textContent = normalizeFrom(m);
			fromName.style.fontSize = "14px";
            fromName.style.fontWeight = "500";
            fromName.style.color = "#000";
			fromName.style.wordBreak = "break-word";

            //const fromEmail = document.createElement("div");
            //fromEmail.textContent = m.from || m.email || "";
            //fromEmail.style.fontSize = "12px";
            //fromEmail.style.color = "#666";
			//fromEmail.style.wordBreak = "break-word";	

            senderBlock.appendChild(fromName);
            //senderBlock.appendChild(fromEmail);

            // ---- 3) Тема ----
            const subj = document.createElement("div");
            subj.textContent = m.subject || m.subj || "(без темы)";
            subj.style.whiteSpace = "normal";
			subj.style.fontSize = "14px";
            subj.style.overflow = "visible";
            subj.style.wordBreak = "break-word";
            subj.style.color = "#000";

            //rowLink.appendChild(dot);
            rowLink.appendChild(senderBlock);
            rowLink.appendChild(subj);

            block.appendChild(rowLink);
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


// ---- Вспомогательные функции ----
function send(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, res => resolve(res || {}));
    } catch (e) {
      console.error("send() error:", e);
      resolve({});
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
  if (mid && /:/.test(mid)) return `https://e.mail.ru/${encodeURIComponent(fid)}/${encodeURIComponent(mid)}/`;
  if (mid) return `https://e.mail.ru/message/${encodeURIComponent(mid)}/?back=1`;
  return "https://e.mail.ru/";
}

// Составной ID для пометки (fid:id или как есть)
function composeId(m) {
  const fidRaw = m.fid ?? m.folder_id ?? m.folder ?? "";
  const fid = (fidRaw == null ? "" : String(fidRaw)).trim();
  const id = m.id || m.mid || m.message_id || m.msgid || "";
  const sid = String(id || "").trim();
  if (!sid) return "";
  if (sid.includes(":")) return sid;
  return fid ? `${fid}:${sid}` : sid;
}

// Применяем normalizeFrom ко всем письмам после загрузки (страховка кэша)
async function updateCache() {
  try {
    const stored = await new Promise(resolve => chrome.storage.local.get(LAST_MESSAGES_KEY, res => resolve(res || {})));
    const cache = stored?.[LAST_MESSAGES_KEY] || {};
    for (const email in cache) {
      const msgs = cache[email] || [];
      for (const m of msgs) {
        try { m.from = normalizeFrom(m); } catch (_) {}
      }
    }
    try { await new Promise(resolve => chrome.storage.local.set({ [LAST_MESSAGES_KEY]: cache }, resolve)); } catch (e) {}
  } catch (e) {
    console.warn("updateCache error:", e);
  }
}

updateCache().then(refresh);
