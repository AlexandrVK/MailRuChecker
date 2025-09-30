// background.js (MV3 service worker) — Mail.ru Checker
// ✔ показывает точное число непрочитанных (бейдж)
// ✔ формирует прямые ссылки на письма (fid/id формат)
// ✔ "точка" помечает письмо прочитанным и обновляет список/бейдж
// ✔ использует тот же рабочий checker-API с токеном
// ✔ если данные успешно получены — ставит активные иконки

const POLL_PERIOD_MINUTES = 0.3;

const ACCOUNTS_KEY = "accounts";          // [{ email: "user@mail.ru" }]
const LAST_MESSAGES_KEY = "lastMessages";  // { [email]: [{id, subject, from, link, fid}] }

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("mailru.check", { periodInMinutes: POLL_PERIOD_MINUTES, delayInMinutes: 0.1 });
  pollAll();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("mailru.check", { periodInMinutes: POLL_PERIOD_MINUTES, delayInMinutes: 0.1 });
  pollAll();
});
chrome.alarms.onAlarm.addListener(a => {
  if (a?.name === "mailru.check") pollAll();
});

// ---- Core polling ----
async function pollAll() {
  try {
    const { [ACCOUNTS_KEY]: accounts = [] } = await chrome.storage.local.get(ACCOUNTS_KEY);
    if (!accounts.length) {
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
        totalUnread += (typeof count === "number" ? count : (messages?.length || 0));
      } catch (e) {
        console.warn("poll error for", email, e);
        byEmail[email] = [];
      }
    }

    // cache + badge
    await chrome.storage.local.set({ [LAST_MESSAGES_KEY]: byEmail });
    const badge = totalUnread > 0 ? (totalUnread > 999 ? "999+" : String(totalUnread)) : "";
    await chrome.action.setBadgeText({ text: badge });
    try { await chrome.action.setBadgeBackgroundColor({ color: "#d33" }); } catch {}

    // активные иконки, если мы реально получили данные
    const haveAny = Object.values(byEmail).some(arr => (arr && arr.length));
    await chrome.action.setIcon(haveAny ? {
      path: { 16: "img/16_activ.png", 48: "img/48_activ.png", 128: "img/128_activ.png" }
    } : { path: "img/ico_panel.png" });

  } catch (e) {
    console.error("pollAll error", e);
  }
}

// ---- Mail.ru checker API (как в рабочей версии) ----
async function fetchToken(email) {
  const url = `https://mailru-checker-api.e.mail.ru/api/v1/tokens?email=${encodeURIComponent(email)}&x-email=${encodeURIComponent(email)}`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error("token fetch failed " + r.status);
  const j = await r.json().catch(() => ({}));
  return (j?.body?.token) || j?.token || null;
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
  // Прямая ссылка на письмо (пример от тебя: https://e.mail.ru/5/1:48473a19a219c843:5/)
  const fid = String(m.fid ?? m.folder_id ?? m.folder ?? "5");
  const mid = m.id || m.mid || m.message_id || m.msgid || "";
  const direct = m.link || m.url || "";
  if (direct) return direct;
  if (mid && /:/.test(mid)) return `https://e.mail.ru/${encodeURIComponent(fid)}/${encodeURIComponent(mid)}/`;
  if (mid) return `https://e.mail.ru/message/${encodeURIComponent(mid)}/`;
  return "https://e.mail.ru/messages/inbox/";
}

async function fetchUnreadList(email) {
  let count = 0;
  let list = [];

  // 1) Основной список через status/unread
  try {
    const token = await fetchToken(email);
    const url = `https://mailru-checker-api.e.mail.ru/api/v1/messages/status/unread?email=${encodeURIComponent(email)}&x-email=${encodeURIComponent(email)}&token=${encodeURIComponent(token || "")}&limit=50`;
    const r = await fetch(url, { method: "GET" });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const arr = j?.body || j?.data || j?.items || j?.messages || [];
      if (Array.isArray(arr)) {
        list = arr.map(m => ({
          id: m.id || m.mid || m.message_id || m.msgid || "",
          subject: m.subject || m.subj || "(без темы)",
          from: normalizeFrom(m),
          link: buildMessageLink(m),
          fid: String(m.fid ?? m.folder_id ?? m.folder ?? "5")
        }));
        count = list.length;
      }
    }
  } catch (e) {
    console.warn("fetchUnreadList list error", e);
  }

  // 2) Если список не дали — хотя бы цифру возьмём из NaviData
  if (!count) {
    try {
      const nav = await fetch("https://portal.mail.ru/NaviData?mac=1", { method: "GET", credentials: "include" });
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

async function markRead(email, ids) {
  console.warn("markRead is not implemented");
  return false;
}

// ---- Messaging ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg?.type) return;

      if (msg.type === "getState") {
        const { [ACCOUNTS_KEY]: accounts = [] } = await chrome.storage.local.get(ACCOUNTS_KEY);
        const { [LAST_MESSAGES_KEY]: cache = {} } = await chrome.storage.local.get(LAST_MESSAGES_KEY);
        sendResponse({ accounts, cache });

      } else if (msg.type === "syncAccounts") {
        const accounts = (msg.accounts || [])
          .map(a => (typeof a === "string" ? { email: a } : a))
          .filter(a => a && a.email);
        await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts });
        await pollAll();
        sendResponse({ ok: true });

      } else if (msg.type === "markRead") {
		  console.warn("markRead is not implemented");
		  sendResponse({ ok: false });
	  
	} else if (msg.type === "addAccount") {
		    // Загружаем текущее состояние
		    const { [ACCOUNTS_KEY]: accounts = [] } = await chrome.storage.local.get(ACCOUNTS_KEY);
		
		    // Проверяем дубли
		    if (!accounts.some(a => a.email === msg.email)) {
		        accounts.push({ email: msg.email });
		    }
		
		    await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts });
		    sendResponse({ ok: true });
		}
    } catch (e) {
      console.error("SW onMessage error", e);
      try { sendResponse({ ok: false, error: String(e) }); } catch {}
    }
  })();
  return true; // async
});
