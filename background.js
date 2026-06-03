// background.js (MV3 service worker) — Mail.ru Checker
// ✔ показывает точное число непрочитанных (бейдж)
// ✔ формирует прямые ссылки на письма (fid/id формат)
// ✔ "точка" помечает письмо прочитанным и обновляет список/бейдж
// ✔ использует тот же рабочий checker-API с токеном
// ✔ если данные успешно получены — ставит активные иконки

const POLL_PERIOD_MINUTES = 0.3;
const MARK_READ_DELAY_MS = 2000;    // пауза после клика "Прочитать" перед закрытием вкладки
const WAIT_LETTERS_MS   = 20000;   // ожидание загрузки списка писем (a.llc)
const WAIT_PANEL_MS     = 10000;   // ожидание появления панели "Выделить все" / "Прочитать" // пауза после клика "Прочитать" перед закрытием вкладки

const ACCOUNTS_KEY = "accounts";
const LAST_MESSAGES_KEY = "lastMessages";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("mailru.check", {
    periodInMinutes: POLL_PERIOD_MINUTES,
    delayInMinutes: 0.1,
  });
  pollAll();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("mailru.check", {
    periodInMinutes: POLL_PERIOD_MINUTES,
    delayInMinutes: 0.1,
  });
  pollAll();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a?.name === "mailru.check") pollAll();
});

// ---- Core polling ----
async function pollAll() {
  let hadError = false;

  try {
    const { [ACCOUNTS_KEY]: accounts = [] } = await chrome.storage.local.get(
      ACCOUNTS_KEY
    );

    if (!accounts.length) {
      // аккаунтов нет — ошибка
      console.error("pollAll error: нет подключенных аккаунтов");
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setIcon({ path: "img/ico_panel.png" });
      await chrome.storage.local.set({ [LAST_MESSAGES_KEY]: {} });
      return;
    }

    let totalUnread = 0;
    const byEmail = {};

    for (const acc of accounts) {
      const email = typeof acc === "string" ? acc : acc.email;
      if (!email) continue;

      try {
        const { count, messages } = await fetchUnreadList(email);
        byEmail[email] = messages || [];
        totalUnread +=
          typeof count === "number" ? count : messages?.length || 0;
      } catch (e) {
        console.error("pollAll error для аккаунта", email, ":", e);
        byEmail[email] = [];
        hadError = true;
      }
    }

    await chrome.storage.local.set({ [LAST_MESSAGES_KEY]: byEmail });

    // ---------- БЕЙДЖ И ИКОНКА ----------
    if (hadError) {
      // ошибка / нет авторизации / сайт недоступен
      console.error("pollAll error: не удалось подключиться к mail.ru");
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setIcon({ path: "img/ico_panel.png" });
    } else {
      // успешное подключение — всегда иконка activ, даже если писем 0
      const badgeText = totalUnread > 999 ? "999+" : String(totalUnread);

      await chrome.action.setBadgeText({ text: badgeText });
      await chrome.action.setBadgeBackgroundColor({ color: "#d33" });
      await chrome.action.setIcon({
        path: {
          16: "img/16_activ.png",
          48: "img/48_activ.png",
          128: "img/128_activ.png",
        },
      });
    }
  } catch (e) {
    // фатальная ошибка pollAll
    console.error("pollAll fatal error:", e);
    try {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setIcon({ path: "img/ico_panel.png" });
    } catch {}
  }
}

// ---- Mail.ru checker API ----
async function fetchToken(email) {
  const url = `https://mailru-checker-api.e.mail.ru/api/v1/tokens?email=${encodeURIComponent(
    email
  )}&x-email=${encodeURIComponent(email)}`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error("token fetch failed " + r.status);
  const j = await r.json().catch(() => ({}));
  return j?.body?.token || j?.token || null;
}

function normalizeFrom(m) {
  const f = m.correspondents?.from?.[0] || m.from || m.sender;
  if (!f) return "";
  if (typeof f === "string") return f;
  const name = f.name || f.display_name || "";
  const mail = f.email || f.address || "";
  if (name && mail) return `${name} <${mail}>`;
  return mail || name || "";
}

function buildMessageLink(m) {
  const fid = String(m.fid ?? m.folder_id ?? m.folder ?? "5");
  const mid = m.id || m.mid || m.message_id || m.msgid || "";
  const direct = m.link || m.url || "";
  if (direct) return direct;
  if (mid && /:/.test(mid))
    return `https://e.mail.ru/${encodeURIComponent(fid)}/${encodeURIComponent(
      mid
    )}/`;
  if (mid) return `https://e.mail.ru/message/${encodeURIComponent(mid)}/`;
  return "https://e.mail.ru/messages/inbox/";
}

async function fetchUnreadList(email) {
  let count = 0;
  let list = [];

  try {
    const token = await fetchToken(email);
    const url = `https://mailru-checker-api.e.mail.ru/api/v1/messages/status/unread?email=${encodeURIComponent(
      email
    )}&x-email=${encodeURIComponent(email)}&token=${encodeURIComponent(
      token || ""
    )}&limit=50`;
    const r = await fetch(url, { method: "GET" });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const arr = j?.body || j?.data || j?.items || j?.messages || [];
      if (Array.isArray(arr)) {
        list = arr.map((m) => ({
          id: m.id || m.mid || m.message_id || m.msgid || "",
          subject: m.subject || m.subj || "(без темы)",
          from: normalizeFrom(m),
          link: buildMessageLink(m),
          fid: String(m.fid ?? m.folder_id ?? m.folder ?? "5"),
        }));
        count = list.length;
      }
    }
  } catch (e) {
    console.warn("fetchUnreadList list error", e);
  }

  if (!count) {
    try {
      const nav = await fetch("https://portal.mail.ru/NaviData?mac=1", {
        method: "GET",
        credentials: "include",
      });
      if (nav.ok) {
        const text = await nav.text();
        const m = text.match(/"unread":\s*(\d+)/i);
        if (m) count = parseInt(m[1], 10) || 0;
      }
    } catch (e) {
      console.warn("NaviData fallback error", e);
    }
  }

  return { count, messages: list };
}

// ---------------- MARK READ SERVICE ----------------

async function openHiddenTab(url) {
  const tab = await chrome.tabs.create({
    url,
    active: false,
  });

  // ⚡ отключаем изображения (ускорение)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const style = document.createElement("style");
        style.textContent = `
          img, picture, video {
            display: none !important;
          }
        `;
        document.documentElement.appendChild(style);
      },
    });
  } catch {}

  return tab.id;
}

function waitForSelector(tabId, selector, timeout = 10000) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, timeout) => {
      return new Promise((resolve, reject) => {
        const found = document.querySelector(selector);
        if (found) return resolve(true);

        const obs = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            obs.disconnect();
            resolve(true);
          }
        });

        obs.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });

        setTimeout(() => {
          obs.disconnect();
          reject("timeout");
        }, timeout);
      });
    },
    args: [selector, timeout],
  });
}

async function exec(tabId, fn) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
  });
}

// ✅ Пометка одного письма через открытие вкладки
async function markOneMessageRead(messageHref) {
  const midMatch = messageHref.match(/(\d+)/);
  if (!midMatch) return;

  const MID = midMatch[1];

  const tabId = await openHiddenTab("https://e.mail.ru/search/?q_read=1");

  try {
    await waitForSelector(tabId, "a.llc", WAIT_LETTERS_MS);

    const res = await chrome.scripting.executeScript({
      target: { tabId },
      args: [MID],
      func: (MID) => {
        function rc(el) {
          ["pointerover","pointerenter","mouseover","mouseenter",
           "pointermove","mousemove","pointerdown","mousedown",
           "pointerup","mouseup","click"].forEach(t =>
            el.dispatchEvent(new MouseEvent(t, {bubbles:true,cancelable:true,view:window}))
          );
        }
        const row = document.querySelector(`a.llc[data-id="${MID}"]`);
        if (!row) return {ok:false, reason:"row not found MID="+MID};
        const dot = row.querySelector('aside[title="Пометить прочитанным"]');
        if (!dot) {
          const titles = Array.from(row.querySelectorAll("aside")).map(a=>a.title||a.className);
          return {ok:false, reason:"aside not found, titles="+JSON.stringify(titles)};
        }
        row.scrollIntoView({block:"center"});
        rc(dot);
        return {ok:true};
      },
    });


    // ждём пока Mail.ru применит изменение перед закрытием вкладки
    await new Promise(r => setTimeout(r, MARK_READ_DELAY_MS));

  } catch(e) {
    console.error("markOne error:", e);
  } finally {
    try { await chrome.tabs.remove(tabId); } catch {}
  }
}

async function markAllReadInList(url) {
  const tabId = await openHiddenTab(url);

  try {
    function rc(el) {
      ["pointerover","pointerenter","mouseover","mouseenter",
       "pointermove","mousemove","pointerdown","mousedown",
       "pointerup","mouseup","click"].forEach(t =>
        el.dispatchEvent(new MouseEvent(t, {bubbles:true,cancelable:true,view:window}))
      );
    }

    await waitForSelector(tabId, "a.llc", WAIT_LETTERS_MS);

    // кликаем "Выделить все" — выделяются все письма, появляется панель "Прочитать"
    await waitForSelector(tabId, "[title*='Выделить все']", WAIT_PANEL_MS);

    const r2 = await exec(tabId, () => {
      function rc(el) {
        ["pointerover","pointerenter","mouseover","mouseenter",
         "pointermove","mousemove","pointerdown","mousedown",
         "pointerup","mouseup","click"].forEach(t =>
          el.dispatchEvent(new MouseEvent(t, {bubbles:true,cancelable:true,view:window}))
        );
      }
      const btn = document.querySelector("[title*='Выделить все']");
      if (!btn) return "select_all not found";
      rc(btn);
      return "select_all clicked";
    });

    // ждём кнопку "Прочитать" (появляется после выделения всех)
    await waitForSelector(tabId, ".button2_status_read", WAIT_PANEL_MS);

    const r3 = await exec(tabId, () => {
      function rc(el) {
        ["pointerover","pointerenter","mouseover","mouseenter",
         "pointermove","mousemove","pointerdown","mousedown",
         "pointerup","mouseup","click"].forEach(t =>
          el.dispatchEvent(new MouseEvent(t, {bubbles:true,cancelable:true,view:window}))
        );
      }
      const btn = document.querySelector(".button2_status_read");
      if (!btn) return "read btn not found";
      rc(btn);
      return "read btn clicked";
    });

    // ждём пока Mail.ru применит изменение перед закрытием вкладки
    await new Promise(r => setTimeout(r, MARK_READ_DELAY_MS));

  } catch (e) {
    console.error("markAllReadInList FAILED:", e);
  } finally {
    try { await chrome.tabs.remove(tabId); } catch {}
  }
}

// ---------------- messaging ----------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      console.log("Background получил сообщение:", msg);

      if (msg.type === "getState") {
        const { [ACCOUNTS_KEY]: accounts = [] } =
          await chrome.storage.local.get(ACCOUNTS_KEY);
        const { [LAST_MESSAGES_KEY]: cache = {} } =
          await chrome.storage.local.get(LAST_MESSAGES_KEY);
        sendResponse({ accounts, cache });
      } else if (msg.type === "markRead") {
    
        try {
          // ▶️ 1 письмо — пришёл href
          if (msg.href) {
            console.log("Пометка одного письма по href:", msg.href);
            await markOneMessageRead(msg.href);
            console.log("Одиночная пометка завершена");
          }
          // ▶️ все письма
          else {
            console.log("Пометка всех писем прочитанными");
            await markAllReadInList("https://e.mail.ru/search/?q_read=1");
            console.log("Массовая пометка завершена");
          }

          // сначала обновляем кэш и бейдж, потом отвечаем popup
          await pollAll();
          sendResponse({ ok: true });
        } catch (e) {
          console.error("markRead FAILED:", e);
          sendResponse({ ok: false, error: String(e) });
        }
      } else if (msg.type === "addAccount") {
        const { [ACCOUNTS_KEY]: accounts = [] } =
          await chrome.storage.local.get(ACCOUNTS_KEY);
        if (
          !accounts.some(
            (a) => (typeof a === "string" ? a : a.email) === msg.email
          )
        ) {
          accounts.push({ email: msg.email });
        }
        await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts });
        await pollAll();
        sendResponse({ ok: true });
      }
    } catch (e) {
      console.error("Message handler error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
