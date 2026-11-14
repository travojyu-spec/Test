/* Облачное сохранение для D&D-инструментов (Cloud save)
   Firebase Auth — вход, Firestore Lite — данные. Бесплатный план Spark.

   Подключение: первым скриптом в <head> каждой страницы
     <script src="cloud.js"></script>
   Страница-хаб показывает панель прямо в тексте: <div data-cloud-panel></div>
   На остальных страницах появляется круглая кнопка с облаком.

   Как работает: сайты по-прежнему пишут в localStorage. Этот файл замечает
   записи по ключам из PREFIXES и через пару секунд отправляет изменённое
   в облако; при входе и при возвращении на вкладку забирает изменения
   с других устройств. Большие списки (персонажи, артефакты, бои)
   хранятся по документу на элемент, поэтому отправляется только изменённое.
*/
(function () {
  'use strict';

  // ===== Настройки (Settings) =====
  const FIREBASE = {
    apiKey: 'AIzaSyBMyiq4_8SAXPA3zuBO-gs5lArfD1_ZRb4',
    authDomain: 'dnd-tools-fe31c.firebaseapp.com',
    projectId: 'dnd-tools-fe31c',
    storageBucket: 'dnd-tools-fe31c.firebasestorage.app',
    messagingSenderId: '503924903349',
    appId: '1:503924903349:web:2094b65e7ef3ef51071dfc'
  };
  const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
  const PREFIXES = ['dnd24-', 'pr_'];   // какие ключи localStorage синхронизировать
  const EXCLUDE = ['dnd24-tracker-v1']; // старый формат трекера, нужен только для переноса
  const HOME = './';                    // ссылка «Все инструменты»

  const META = 'cloud-meta-v1', TOAST = 'cloud-toast';
  // Пробный сайт (/Test/) хранит данные отдельно от рабочего: свои ключи в браузере и свой набор в облаке.
  // На рабочем сайте NS пустой, и всё работает как раньше.
  const NS = /^\/test(\/|$)/i.test(location.pathname) ? 'test:' : '';
  const SEP = '~', RAW = '\u0000raw:', MK = '__cloudArr', ID_FIELDS = ['id', 'iid'];
  const CHUNK = 300000, SPLIT_MIN = 4096, DEBOUNCE = 2500, MAXWAIT = 15000;

  let LS = null;
  try { LS = window.localStorage; LS.length; } catch (e) { LS = null; }
  if (!LS || window.CloudSync) return;

  // ===== Перехват записей в localStorage =====
  const SP = Storage.prototype, oGet = SP.getItem, oSet = SP.setItem, oRem = SP.removeItem;
  const readKeys = new Set(), blocked = new Set();
  let userActive = false;
  const ours = k => typeof k === 'string' && PREFIXES.some(p => k.startsWith(p));
  const isSynced = k => ours(k) && k.indexOf(SEP) < 0 && !EXCLUDE.includes(k);
  const nsk = k => NS && (ours(k) || k === META) ? NS + k : k;        // логический ключ → ключ в хранилище
  const lk = r => !NS ? r : (typeof r === 'string' && r.startsWith(NS) ? r.slice(NS.length) : null); // обратно

  SP.getItem = function (k) {
    if (this === LS && isSynced(String(k))) readKeys.add(String(k));
    return oGet.call(this, this === LS ? nsk(String(k)) : k);
  };
  SP.setItem = function (k, v) {
    k = String(k);
    if (this === LS && blocked.has(k)) return; // страница перезагружается с новыми данными
    oSet.call(this, this === LS ? nsk(k) : k, v);
    if (this === LS && isSynced(k)) changed(k);
  };
  SP.removeItem = function (k) {
    k = String(k);
    if (this === LS && blocked.has(k)) return;
    oRem.call(this, this === LS ? nsk(k) : k);
    if (this === LS && isSynced(k)) changed(k);
  };
  // Записи до первого касания — служебные (страница сохранила себя при загрузке),
  // они не считаются свежими правками при спорах между устройствами.
  ['pointerdown', 'keydown', 'touchstart'].forEach(t =>
    addEventListener(t, () => { userActive = true; }, { capture: true, passive: true }));

  // ===== Служебные данные синхронизации =====
  const blank = () => ({ uid: null, base: {}, n: {}, kt: {}, first: false });
  function loadMeta() {
    try {
      const m = JSON.parse(oGet.call(LS, nsk(META)));
      if (m && typeof m === 'object') return Object.assign(blank(), m);
    } catch (e) {}
    return blank();
  }
  let meta = loadMeta();
  function saveMeta() { try { oSet.call(LS, nsk(META), JSON.stringify(meta)); } catch (e) {} }
  // перечитать (могла писать другая вкладка), сохранив свежие отметки правок
  function refreshMeta(uid) {
    const m = loadMeta(), kt = meta.kt;
    for (const k in m.kt) if (!(kt[k] >= m.kt[k])) kt[k] = m.kt[k];
    meta = Object.assign(m, { kt });
    if (meta.uid !== uid) Object.assign(meta, { uid, base: {}, n: {}, first: true });
  }

  // ===== Разбиение значений на документы =====
  function hash(str) { // cyrb53 + длина
    let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '.' + str.length.toString(36);
  }
  function chunks(s) {
    const out = [];
    for (let i = 0; i < s.length;) {
      let j = Math.min(s.length, i + CHUNK);
      if (j < s.length) { const c = s.charCodeAt(j - 1); if (c >= 0xD800 && c <= 0xDBFF) j--; }
      out.push(s.slice(i, j)); i = j;
    }
    return out.length ? out : [''];
  }
  function idField(a) {
    if (!Array.isArray(a) || !a.length) return null;
    for (const f of ID_FIELDS) {
      const seen = new Set(); let ok = true;
      for (const x of a) {
        if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
        const v = x[f], t = typeof v, s = String(v);
        if ((t !== 'string' && t !== 'number') || !s || s.length > 300 || seen.has(s)) { ok = false; break; }
        seen.add(s);
      }
      if (ok) return f;
    }
    return null;
  }
  // значение ключа → { docId: строка }. Голова хранит всё, кроме больших списков,
  // каждый элемент такого списка — отдельный документ key~поле~id
  function split(key, raw) {
    const out = {};
    let v;
    try { v = JSON.parse(raw); } catch (e) { out[key] = RAW + raw; return out; }
    const pack = (p, a) => {
      const f = idField(a); if (!f) return a;
      const strs = a.map(x => JSON.stringify(x));
      let len = 0; for (const s of strs) len += s.length;
      if (len < SPLIT_MIN) return a;
      a.forEach((x, i) => { out[key + SEP + p + SEP + String(x[f])] = strs[i]; });
      return { [MK]: p, f, ids: a.map(x => x[f]) };
    };
    if (Array.isArray(v)) v = pack('', v);
    else if (v && typeof v === 'object')
      v = Object.fromEntries(Object.entries(v).map(([k, x]) =>
        [k, Array.isArray(x) && k.indexOf(SEP) < 0 ? pack(k, x) : x]));
    out[key] = JSON.stringify(v);
    return out;
  }
  const idOf = x => x && typeof x === 'object' ? (x.id !== undefined ? x.id : x.iid) : undefined;
  const isMk = x => !!x && typeof x === 'object' && !Array.isArray(x) && typeof x[MK] === 'string' && Array.isArray(x.ids);
  // обратная сборка; элементы, которых нет в порядке головы, добавляются в конец
  function join(key, docs) {
    const head = docs[key];
    if (head == null) return null;
    if (head.startsWith(RAW)) return head.slice(RAW.length);
    let v = JSON.parse(head);
    const pools = new Map(), pre = key + SEP;
    for (const id in docs) {
      if (!id.startsWith(pre)) continue;
      const rest = id.slice(pre.length), j = rest.indexOf(SEP);
      if (j < 0) continue;
      const p = rest.slice(0, j);
      if (!pools.has(p)) pools.set(p, new Map());
      pools.get(p).set(rest.slice(j + 1), docs[id]);
    }
    const take = (p, ids, inline) => {
      const pool = pools.get(p) || new Map(), out = [], seen = new Set();
      if (inline) for (const x of inline) { out.push(x); const i = idOf(x); if (i !== undefined) seen.add(String(i)); }
      for (const i of ids) { const s = String(i); if (!seen.has(s) && pool.has(s)) { out.push(JSON.parse(pool.get(s))); seen.add(s); } }
      for (const [s, str] of pool) if (!seen.has(s)) { out.push(JSON.parse(str)); seen.add(s); }
      return out;
    };
    if (isMk(v)) v = take(v[MK], v.ids);
    else if (Array.isArray(v)) { if (pools.has('')) v = take('', [], v); }
    else if (v && typeof v === 'object')
      v = Object.fromEntries(Object.entries(v).map(([k, x]) =>
        [k, isMk(x) ? take(x[MK], x.ids) : (Array.isArray(x) && pools.has(k)) ? take(k, [], x) : x]));
    return JSON.stringify(v);
  }
  const keyOf = id => { const i = id.indexOf(SEP); return i < 0 ? id : id.slice(0, i); };

  const cache = new Map(); // key → { raw, docs: { id: {s, h} } }
  function docsOf(key) {
    const raw = oGet.call(LS, nsk(key)), c = cache.get(key);
    if (c && c.raw === raw) return c.docs;
    const docs = {};
    if (raw != null) { const sp = split(key, raw); for (const id in sp) docs[id] = { s: sp[id], h: hash(sp[id]) }; }
    cache.set(key, { raw, docs });
    return docs;
  }
  function localDocs() {
    const all = {};
    for (let i = 0; i < LS.length; i++) { const k = lk(LS.key(i)); if (k && isSynced(k)) Object.assign(all, docsOf(k)); }
    return all;
  }

  // ===== Firebase =====
  let Au = null, Fs = null, auth = null, db = null, user = null;
  let phase = location.protocol === 'file:' ? 'file' : 'loading'; // file | loading | noload | ready
  let status = 'out', statusErr = '', lastOk = 0, lastPull = 0, tmr = 0, metaT = 0, firstDirty = 0, retryT = 0;

  const dref = (uid, id, i) => Fs.doc(db, 'users', uid, 'docs', encodeURIComponent(NS + id) + (i ? '#' + i : ''));
  const mref = uid => Fs.doc(db, 'users', uid, 'meta', NS ? 'manifest-test' : 'manifest');

  async function boot() {
    if (phase === 'file') return render();
    try {
      const [A, au, fs] = await Promise.all([
        import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore-lite.js')]);
      Au = au; Fs = fs;
      const app = A.initializeApp(FIREBASE);
      auth = Au.getAuth(app); auth.languageCode = 'ru';
      db = Fs.getFirestore(app);
    } catch (e) { phase = 'noload'; return render(); }
    Au.onAuthStateChanged(auth, u => {
      phase = 'ready'; user = u || null;
      if (user) { ui.msg = ''; setStatus('busy'); sync(true); }
      else { clearTimeout(tmr); tmr = 0; firstDirty = 0; setStatus('out'); }
    });
  }

  function changed(k) {
    if (userActive) meta.kt[k] = Date.now();
    schedule();
  }
  function schedule() {
    if (!user) { clearTimeout(metaT); metaT = setTimeout(saveMeta, 1000); return; }
    clearTimeout(tmr);
    const now = Date.now();
    if (!firstDirty) firstDirty = now;
    if (status === 'ok') setStatus('pending');
    tmr = setTimeout(flush, Math.max(0, Math.min(DEBOUNCE, firstDirty + MAXWAIT - now)));
  }
  function flush() {
    clearTimeout(tmr); tmr = 0; firstDirty = 0;
    return sync(Date.now() - lastPull > 60000);
  }

  let running = null, again = null;
  function sync(pull) {
    if (!user) return Promise.resolve();
    if (running) { again = { pull: !!(pull || (again && again.pull)) }; return running; }
    running = (async () => {
      let p = !!pull;
      for (;;) {
        await run(p);
        if (!again || !user) break;
        p = again.pull; again = null;
      }
    })().finally(() => { running = null; again = null; });
    return running;
  }

  async function run(pull) {
    const u = user;
    refreshMeta(u.uid);
    setStatus('busy');
    let fresh = [];
    try {
      if (pull) fresh = await doPull(u.uid);
      if (user !== u) return;
      await doPush(u.uid);
      lastOk = Date.now(); clearTimeout(retryT); retryT = 0;
      setStatus(tmr ? 'pending' : 'ok');
    } catch (e) { fail(e); }
    saveMeta();
    const hit = fresh.filter(k => readKeys.has(k));
    if (hit.length) reloadWith(hit);
  }

  // забрать изменения: трёхстороннее сравнение «здесь / база / облако»
  async function doPull(uid) {
    const snap = await Fs.getDoc(mref(uid));
    lastPull = Date.now();
    let R = snap.exists() ? (snap.data().docs || {}) : null;
    if (!R) { meta.base = {}; meta.n = {}; R = {}; } // в облаке пусто — ничего не удаляем, всё отправим
    const first = !!meta.first, L = localDocs();
    const ids = new Set([...Object.keys(L), ...Object.keys(meta.base), ...Object.keys(R)]);
    const pulls = [], drops = [];
    for (const id of ids) {
      const r = R[id], lh = L[id] ? L[id].h : null, bh = meta.base[id] || null, rh = (r && r.h) || null;
      if (lh === rh) {
        if (rh) { meta.base[id] = rh; meta.n[id] = r.n || 1; } else { delete meta.base[id]; delete meta.n[id]; }
        continue;
      }
      if (rh === bh) continue;            // в облаке не менялось — отправим своё
      if (lh === bh) { (rh ? pulls : drops).push(id); continue; } // меняли только там
      if (!lh) { pulls.push(id); continue; } // здесь удалили, там изменили — вернуть
      if (!rh) continue;                  // там удалили, здесь изменили — оставить
      const lt = first ? 0 : (meta.kt[keyOf(id)] || 0);
      if ((r.t || 0) >= lt) pulls.push(id); // правили и тут и там — побеждает свежая правка
    }
    const got = {};
    await Promise.all(pulls.map(async id => {
      const n = Math.max(1, R[id].n || 1);
      const parts = await Promise.all(Array.from({ length: n }, (_, i) => Fs.getDoc(dref(uid, id, i))));
      if (parts.some(p => !p.exists())) return;
      const s = parts.map(p => p.data().d || '').join('');
      if (hash(s) === R[id].h) got[id] = s; // недописанное пропускаем до следующего раза
    }));
    const keys = new Set([...Object.keys(got), ...drops].map(keyOf)), fresh = [];
    for (const key of keys) {
      const cur = {}, ld = docsOf(key);
      for (const id in ld) cur[id] = ld[id].s;
      for (const id in got) if (keyOf(id) === key) cur[id] = got[id];
      for (const id of drops) if (keyOf(id) === key) delete cur[id];
      let raw;
      try { raw = join(key, cur); } catch (e) { continue; }
      if (raw !== oGet.call(LS, nsk(key))) {
        try { raw == null ? oRem.call(LS, nsk(key)) : oSet.call(LS, nsk(key), raw); }
        catch (e) { setStatus('error', 'В браузере не хватает места для данных из облака. Удалите лишнее и нажмите «Синхронизировать».'); continue; }
        fresh.push(key);
      }
      for (const id in got) if (keyOf(id) === key) { meta.base[id] = R[id].h; meta.n[id] = R[id].n || 1; }
      for (const id of drops) if (keyOf(id) === key) { delete meta.base[id]; delete meta.n[id]; }
    }
    if (pulls.every(id => id in got)) meta.first = false;
    saveMeta();
    return fresh;
  }

  // отправить всё, что отличается от последней синхронизированной версии
  async function doPush(uid) {
    const L = localDocs(), ops = [];
    for (const id of new Set([...Object.keys(L), ...Object.keys(meta.base)]))
      if ((L[id] ? L[id].h : null) !== (meta.base[id] || null)) ops.push(id);
    if (!ops.length) return;
    const now = Date.now(), enc = new TextEncoder();
    let b = Fs.writeBatch(db), man = {}, cnt = 0, size = 0, done = [];
    const commit = async () => {
      if (!done.length) return;
      b.set(mref(uid), { docs: man }, { merge: true });
      await b.commit();
      for (const d of done) {
        if (d.h) { meta.base[d.id] = d.h; meta.n[d.id] = d.n; } else { delete meta.base[d.id]; delete meta.n[d.id]; }
      }
      saveMeta();
      b = Fs.writeBatch(db); man = {}; cnt = 0; size = 0; done = [];
    };
    for (const id of ops) {
      const l = L[id], old = meta.n[id] || (meta.base[id] ? 1 : 0);
      const parts = l ? chunks(l.s) : [];
      const need = Math.max(parts.length, old) + 1, bytes = l ? enc.encode(l.s).length : 0;
      if (done.length && (cnt + need > 450 || size + bytes > 7e6)) await commit();
      parts.forEach((p, i) => b.set(dref(uid, id, i), { d: p }));
      for (let i = parts.length; i < old; i++) b.delete(dref(uid, id, i));
      man[id] = l ? { h: l.h, t: meta.kt[keyOf(id)] || now, n: parts.length } : Fs.deleteField();
      cnt += need; size += bytes; done.push({ id, h: l ? l.h : null, n: parts.length });
    }
    await commit();
  }

  function reloadWith(keys) {
    keys.forEach(k => blocked.add(k)); // старое состояние страницы больше не запишется
    try { sessionStorage.setItem(TOAST, 'Загружены изменения из облака'); } catch (e) {}
    location.reload();
  }

  function fail(e) {
    const code = (e && e.code) || '';
    if (!navigator.onLine || code === 'unavailable' || code === 'deadline-exceeded') { setStatus('offline'); return; }
    const M = {
      'permission-denied': 'Нет доступа к базе. Проверьте правила Firestore (вкладка Rules).',
      'unauthenticated': 'Вход устарел. Выйдите и войдите снова.',
      'not-found': 'База не создана: Firebase → Firestore Database → Create database.',
      'failed-precondition': 'База не создана: Firebase → Firestore Database → Create database.',
      'resource-exhausted': 'Дневной бесплатный лимит базы исчерпан. Данные в браузере целы, отправлю позже.',
      'invalid-argument': 'Облако не приняло данные. Попробуйте ещё раз позже.'
    };
    setStatus('error', M[code] || ('Не удалось синхронизировать: ' + ((e && e.message) || e)));
    clearTimeout(retryT);
    retryT = setTimeout(() => { retryT = 0; sync(true); }, code === 'resource-exhausted' ? 600000 : 60000);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { saveMeta(); if (tmr && user) flush(); }
    else if (user && Date.now() - lastPull > 20000) sync(true);
  });
  addEventListener('pagehide', () => { saveMeta(); if (tmr && user) flush(); });
  addEventListener('online', () => { if (user) sync(true); });
  addEventListener('offline', () => { if (user) setStatus('offline'); });

  // ===== Вход и выход =====
  const AUTH_ERR = {
    'auth/invalid-email': 'Почта записана с ошибкой.',
    'auth/missing-email': 'Впишите почту.',
    'auth/missing-password': 'Впишите пароль.',
    'auth/weak-password': 'Пароль слишком короткий: нужно хотя бы 6 символов.',
    'auth/invalid-credential': 'Неверная почта или пароль.',
    'auth/invalid-login-credentials': 'Неверная почта или пароль.',
    'auth/wrong-password': 'Неверная почта или пароль.',
    'auth/user-not-found': 'Аккаунта с такой почтой нет. Нажмите «Создать аккаунт».',
    'auth/email-already-in-use': 'Аккаунт с этой почтой уже есть. Нажмите «Войти».',
    'auth/popup-blocked': 'Браузер заблокировал окно входа. Разрешите всплывающие окна для этого сайта и нажмите ещё раз.',
    'auth/unauthorized-domain': 'Этот адрес не разрешён для входа. Firebase → Authentication → Settings → Authorized domains: добавьте ' + location.hostname + '.',
    'auth/operation-not-allowed': 'Этот способ входа выключен. Firebase → Authentication → Sign-in method: включите его.',
    'auth/network-request-failed': 'Нет связи с сервером входа. Проверьте интернет.',
    'auth/too-many-requests': 'Слишком много попыток. Подождите пару минут.',
    'auth/user-disabled': 'Этот аккаунт отключён.',
    'auth/account-exists-with-different-credential': 'Эта почта уже привязана к другому способу входа. Войдите тем способом, которым создавали аккаунт.',
    'auth/web-storage-unsupported': 'Браузер запрещает хранить данные сайта (режим инкогнито?), вход невозможен.',
    'auth/internal-error': 'Сервер входа ответил ошибкой. Попробуйте ещё раз.'
  };
  function authErr(e) {
    const c = e && e.code;
    if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request' || c === 'auth/user-cancelled') return;
    setMsg(AUTH_ERR[c] || ('Не получилось войти: ' + (c || e)), 'err');
  }
  async function logout(wipe) {
    if (!auth) return;
    if (user) { clearTimeout(tmr); tmr = 0; try { await sync(false); } catch (e) {} }
    try { await Au.signOut(auth); } catch (e) {}
    meta = Object.assign(blank(), { kt: wipe ? {} : meta.kt });
    saveMeta(); ui.wipe = false;
    if (wipe) {
      const ks = [];
      for (let i = 0; i < LS.length; i++) { const k = lk(LS.key(i)); if (k && ours(k)) ks.push(k); }
      ks.forEach(k => oRem.call(LS, nsk(k))); cache.clear();
      try { sessionStorage.setItem(TOAST, 'Вы вышли, данные с этого устройства стёрты'); } catch (e) {}
      location.reload();
    } else setMsg('Вы вышли. Данные остались в этом браузере.', 'ok');
  }

  // ===== Интерфейс =====
  const ui = { open: false, msg: '', kind: '', wipe: false, busy: false };
  const roots = [];
  let fabRoot = null, toastT = 0;

  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 19h10.5a4.5 4.5 0 0 0 .4-8.98A6.25 6.25 0 0 0 5.9 8.6 5.2 5.2 0 0 0 7 19z"/></svg>';
  const GLOGO = '<svg class="gl" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.7-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.7-.4-3.9z"/></svg>';
  const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const CSS = `
:host{--bg:#E9EDE7;--sf:#F8FAF6;--sf2:#DDE4DC;--ink:#1C2A2B;--mu:#5A6865;--ln:#C3CDC5;--ac:#2B6D66;--aci:#fff;--acs:#D3E6E1;--wn:#8C2C3A;--ok:#2E7D4F;--mid:#B07A1F;
 --gbg:#fff;--gink:#1f1f1f;--gln:#747775;
 --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Noto Serif","PT Serif",Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;
 display:block;font:15px/1.45 var(--sans);color:var(--ink);letter-spacing:normal;text-align:left;text-transform:none;-webkit-tap-highlight-color:transparent}
@media (prefers-color-scheme:dark){:host{--bg:#111718;--sf:#192122;--sf2:#243031;--ink:#E1E8E3;--mu:#96A4A0;--ln:#2F3C3D;--ac:#66B5AA;--aci:#0B1918;--acs:#1E3936;--wn:#E78C97;--ok:#6CC08F;--mid:#E0B063;--gbg:#131314;--gink:#e3e3e3;--gln:#8e918f}}
*{box-sizing:border-box}
button,input{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
[hidden]{display:none!important}
.fab{position:fixed;right:12px;bottom:var(--fb,calc(env(safe-area-inset-bottom,0px) + 16px));transition:transform .2s,opacity .2s,bottom .15s;width:44px;height:44px;border-radius:50%;border:1px solid var(--ln);background:var(--sf);color:var(--ink);display:grid;place-items:center;padding:0;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.18)}
.fab svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linejoin:round}
.fab[data-s=out]{color:var(--mu)}
.fab.hid{transform:translateY(14px) scale(.85);opacity:0;pointer-events:none}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--mu);flex:none}
.fab .dot{position:absolute;right:6px;bottom:7px;border:2px solid var(--sf);width:12px;height:12px}
[data-s=out] .dot,[data-s=loading] .dot{display:none}
[data-s=ok] .dot{background:var(--ok)}
[data-s=busy] .dot,[data-s=pending] .dot{background:var(--mid)}
[data-s=busy] .dot{animation:pulse 1s ease-in-out infinite alternate}
[data-s=offline] .dot{background:var(--mu)}
[data-s=error] .dot{background:var(--wn)}
@keyframes pulse{to{opacity:.35}}
.wrap{position:fixed;inset:0;visibility:hidden;transition:visibility 0s .2s}
.wrap.open{visibility:visible;transition:none}
.ov{position:absolute;inset:0;background:rgba(8,18,16,.45);opacity:0;transition:opacity .2s}
.open .ov{opacity:1}
.sh{position:absolute;left:0;right:0;bottom:0;max-width:440px;margin:0 auto;max-height:calc(100% - 24px - env(safe-area-inset-top,0px));overflow:auto;overscroll-behavior:contain;background:var(--sf);border-radius:18px 18px 0 0;padding:6px 18px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 30px rgba(0,0,0,.25);transform:translateY(100%);transition:transform .22s ease-out}
.open .sh{transform:none}
@media (min-width:640px){.sh{bottom:auto;top:50%;border-radius:18px;padding-bottom:18px;transform:translateY(-46%);opacity:0;transition:transform .2s ease-out,opacity .2s}.open .sh{transform:translateY(-50%);opacity:1}}
@media (prefers-reduced-motion:reduce){.wrap,.ov,.sh,.fab{transition:none!important}[data-s=busy] .dot{animation:none}}
.grab{width:40px;height:4px;border-radius:2px;background:var(--ln);margin:4px auto 6px}
@media (min-width:640px){.grab{display:none}}
.hd{display:flex;align-items:flex-start;gap:8px;margin:6px 0 10px}
.hd h2{flex:1;margin:0;font:600 21px/1.2 var(--serif)}
.hd h2 small{display:block;font:400 12px/1.4 var(--sans);color:var(--mu);margin-top:2px}
.x{flex:none;width:40px;height:40px;margin:-6px -8px 0 0;border:0;background:none;border-radius:10px;display:grid;place-items:center;color:var(--mu);cursor:pointer}
.x svg{width:20px;height:20px;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.lead{margin:0 0 14px;color:var(--mu);font-size:14.5px;max-width:52ch}
.b{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:46px;padding:10px 16px;border-radius:12px;border:1px solid var(--ln);background:var(--sf);color:var(--ink);font-weight:600;font-size:15px;cursor:pointer;text-decoration:none}
.b:active{background:var(--sf2)}
.b.pri{background:var(--ac);border-color:var(--ac);color:var(--aci)}
.b.g{background:var(--gbg);border-color:var(--gln);color:var(--gink)}
.b:disabled{opacity:.55;cursor:default}
.gl{width:20px;height:20px;flex:none}
.or{display:flex;align-items:center;gap:10px;margin:16px 0 4px;color:var(--mu);font-size:13px}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--ln)}
.f{display:block;margin-top:10px}
.f span{display:block;font-size:13px;color:var(--mu);margin-bottom:4px}
.f input{display:block;width:100%;min-height:46px;padding:10px 12px;border:1px solid var(--ln);border-radius:12px;background:var(--bg);color:var(--ink);font-size:16px}
.row{display:flex;gap:8px;margin-top:14px}
.row .b{flex:1 1 0;width:auto;min-width:0;padding:8px;font-size:14.5px;line-height:1.15;text-align:center}
.lnk{display:inline-block;border:0;background:none;padding:10px 0 4px;color:var(--ac);font-size:14px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.lnk.danger{color:var(--wn)}
.msg{margin:12px 0 0;font-size:14px}
.msg:empty{display:none}
.msg.err{color:var(--wn)}
.msg.ok{color:var(--ok)}
.acct{display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;background:var(--bg);border:1px solid var(--ln)}
.av{flex:none;width:42px;height:42px;border-radius:50%;background:var(--ac);color:var(--aci);display:grid;place-items:center;font:600 19px var(--serif)}
.acct .who{min-width:0;flex:1}
.acct b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{display:flex;align-items:center;gap:7px;margin-top:2px;font-size:13.5px;color:var(--mu)}
.note{margin:14px 0 0;font-size:13px;color:var(--mu);max-width:52ch}
.home{display:block;margin-top:14px;padding-top:12px;border-top:1px solid var(--ln);color:var(--ink);font-size:14px;text-decoration:none}
.home::after{content:" ›";color:var(--mu)}
.toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);transform:translate(-50%,-8px);max-width:88vw;padding:9px 16px;border-radius:999px;background:var(--ink);color:var(--sf);font-size:13.5px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toast.on{opacity:1;transform:translate(-50%,0)}
`;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hhmm = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  function statusText() {
    switch (status) {
      case 'ok': return 'Всё сохранено в облаке' + (lastOk ? ' в ' + hhmm(lastOk) : '');
      case 'busy': return 'Синхронизирую…';
      case 'pending': return 'Есть правки, отправлю через пару секунд';
      case 'offline': return 'Нет интернета. Отправлю, когда связь вернётся';
      case 'error': return statusErr;
      default: return '';
    }
  }
  const viewOf = () => phase !== 'ready' ? phase : user ? 'in' : 'out';

  function panelHTML(view, inline) {
    const head = `<div class="hd"><h2>Облачное сохранение<small lang="en">${NS ? 'Пробный сайт — данные отдельно от рабочего' : 'Cloud save'}</small></h2>${inline ? '' : `<button type="button" class="x" data-c="close" aria-label="Закрыть">${CLOSE}</button>`}</div>`;
    const home = inline ? '' : `<a class="home" href="${HOME}">Все инструменты</a>`;
    if (view === 'file') return head + `<p class="lead">Вход работает, когда сайт открыт по адресу в интернете (например, на GitHub Pages). Сейчас страница открыта из файла, поэтому данные хранятся только в этом браузере.</p>` + home;
    if (view === 'loading') return head + `<p class="lead">Подключаюсь…</p>` + home;
    if (view === 'noload') return head + `<p class="lead">Не удалось загрузить модуль входа. Проверьте интернет. Данные по-прежнему сохраняются в этом браузере.</p><button type="button" class="b" data-c="retry">Попробовать снова</button>` + home;
    if (view === 'out') return head +
      `<p class="lead">Войдите, чтобы персонажи, бои и цены хранились в аккаунте и открывались на любом устройстве.</p>
<button type="button" class="b g" data-c="google">${GLOGO}Войти через Google</button>
<div class="or">или по почте</div>
<label class="f"><span>Почта</span><input type="email" name="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false"></label>
<label class="f"><span>Пароль</span><input type="password" name="pw" autocomplete="current-password"></label>
<div class="row"><button type="button" class="b pri" data-c="in">Войти</button><button type="button" class="b" data-c="up">Создать аккаунт</button></div>
<button type="button" class="lnk" data-c="reset">Забыли пароль?</button>
<p class="msg" role="status"></p>
<p class="note">Без входа всё работает как раньше, но данные хранятся только в этом браузере.</p>` + home;
    return head +
      `<div class="acct"><span class="av"></span><div class="who"><b class="em"></b><span class="st"><i class="dot"></i><span class="stt"></span></span></div></div>
<p class="msg" role="status"></p>
<div class="row"><button type="button" class="b pri" data-c="sync">Синхронизировать</button><button type="button" class="b" data-c="out">Выйти</button></div>
<button type="button" class="lnk danger" data-c="wipe"></button>
<p class="note">Сохраняется само: в браузере сразу, в облаке через пару секунд после правки. На другом устройстве войдите в тот же аккаунт.</p>` + home;
  }

  function render() {
    const view = viewOf();
    for (const r of roots) {
      const pn = r.root.querySelector('.pn');
      if (pn.dataset.v !== view) { pn.dataset.v = view; pn.innerHTML = panelHTML(view, r.inline); }
      pn.dataset.s = view === 'in' ? status : 'out';
      const m = pn.querySelector('.msg');
      if (m) { m.textContent = ui.msg; m.className = 'msg' + (ui.kind ? ' ' + ui.kind : ''); }
      if (view === 'in') {
        const name = (user && (user.email || user.displayName)) || 'Аккаунт';
        pn.querySelector('.em').textContent = name;
        pn.querySelector('.av').textContent = name.trim().charAt(0).toUpperCase();
        pn.querySelector('.stt').textContent = statusText();
        pn.querySelector('[data-c=wipe]').textContent = ui.wipe ? 'Точно стереть? Нажмите ещё раз' : 'Выйти и стереть данные с этого устройства';
        pn.querySelector('[data-c=sync]').disabled = status === 'busy';
      }
      pn.querySelectorAll('[data-c=google],[data-c=in],[data-c=up]').forEach(b => { b.disabled = ui.busy; });
    }
    if (fabRoot) {
      const fab = fabRoot.querySelector('.fab'), s = phase !== 'ready' ? (phase === 'loading' ? 'loading' : 'out') : user ? status : 'out';
      fab.dataset.s = s;
      fab.setAttribute('aria-label', 'Облачное сохранение: ' + (user ? statusText() : 'вход не выполнен'));
    }
  }
  function setStatus(s, text) { status = s; if (text !== undefined) statusErr = text; render(); }
  function setMsg(text, kind) { ui.msg = text || ''; ui.kind = kind || ''; render(); }
  function toast(text) {
    const r = roots[0]; if (!r) return;
    const t = r.root.querySelector('.toast'); t.textContent = text; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800);
  }

  function open() {
    if (!fabRoot) return;
    ui.open = true; fabRoot.host.classList.add('open');
    fabRoot.querySelector('.wrap').classList.add('open');
    setTimeout(() => { const f = fabRoot.querySelector('.sh button, .sh input'); if (f) f.focus({ preventScroll: true }); }, 60);
  }
  function close() {
    if (!fabRoot || !ui.open) return;
    ui.open = false; fabRoot.querySelector('.wrap').classList.remove('open');
    setTimeout(() => { if (!ui.open) fabRoot.host.classList.remove('open'); }, 220);
    fabRoot.querySelector('.fab').focus({ preventScroll: true });
  }

  function act(c, root) {
    const val = n => { const i = root.querySelector(`input[name=${n}]`); return i ? i.value.trim() : ''; };
    switch (c) {
      case 'open': return open();
      case 'close': return close();
      case 'retry': return location.reload();
      case 'google':
        if (!auth || ui.busy) return;
        setMsg('');
        Au.signInWithPopup(auth, new Au.GoogleAuthProvider()).catch(authErr);
        return;
      case 'in': case 'up': {
        if (!auth || ui.busy) return;
        const em = val('email'), pw = root.querySelector('input[name=pw]').value;
        if (!em) return setMsg('Впишите почту.', 'err');
        if (!pw) return setMsg('Впишите пароль.', 'err');
        if (c === 'up' && pw.length < 6) return setMsg('Пароль слишком короткий: нужно хотя бы 6 символов.', 'err');
        ui.busy = true; setMsg(c === 'up' ? 'Создаю аккаунт…' : 'Вхожу…');
        (c === 'up' ? Au.createUserWithEmailAndPassword : Au.signInWithEmailAndPassword)(auth, em, pw)
          .then(() => setMsg(''), authErr).finally(() => { ui.busy = false; render(); });
        return;
      }
      case 'reset': {
        if (!auth) return;
        const em = val('email');
        if (!em) return setMsg('Впишите почту в поле выше, и мы пришлём ссылку для нового пароля.', 'err');
        Au.sendPasswordResetEmail(auth, em)
          .then(() => setMsg('Ссылка для нового пароля отправлена на ' + em + '. Загляните и в «Спам».', 'ok'), authErr);
        return;
      }
      case 'sync':
        setMsg('');
        sync(true).then(() => { if (status === 'ok') setMsg('Готово, всё совпадает с облаком.', 'ok'); });
        return;
      case 'out': return logout(false);
      case 'wipe':
        if (!ui.wipe) { ui.wipe = true; render(); setTimeout(() => { ui.wipe = false; render(); }, 5000); return; }
        return logout(true);
    }
  }

  function bind(root, hostEl) {
    root.addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (b) { e.preventDefault(); act(b.dataset.c, root); } });
    root.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && e.target.name === 'pw') act('in', root);
    });
    // события панели не должны доходить до обработчиков самой страницы
    ['click', 'keydown', 'keyup', 'keypress', 'input', 'change', 'focusin', 'focusout', 'submit']
      .forEach(t => hostEl.addEventListener(t, e => e.stopPropagation()));
  }

  // кнопка встаёт над нижней панелью страницы и прячется, пока страницу листают вниз
  function place(host) {
    const fab = fabRoot.querySelector('.fab');
    let lastY = scrollY, q = 0;
    const barTop = () => {
      const w = innerWidth, h = innerHeight; let top = h;
      for (const x of [w / 2, w - 34]) {
        const el = document.elementsFromPoint(x, h - 3).find(e => e !== host && e !== document.documentElement && e !== document.body);
        for (let e = el; e && e !== document.body; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.position === 'fixed' || cs.position === 'sticky') {
            const r = e.getBoundingClientRect();
            if (r.bottom >= h - 4 && r.height < h * 0.4) top = Math.min(top, r.top);
            break;
          }
        }
      }
      return h - top;
    };
    const fit = () => { q = 0; const b = barTop(); host.style.setProperty('--fb', b ? (b + 12) + 'px' : ''); };
    const later = () => { if (!q) q = setTimeout(fit, 120); };
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', later);
    addEventListener('scroll', () => {
      const y = scrollY;
      if (y > lastY + 6 && y > 80) fab.classList.add('hid');
      else if (y < lastY - 6 || y <= 80) fab.classList.remove('hid');
      lastY = y; later();
    }, { passive: true });
    fit();
  }

  function mount() {
    const holder = document.querySelector('[data-cloud-panel]');
    if (holder) {
      const root = holder.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="pn"></div><div class="toast" role="status"></div>`;
      roots.push({ root, inline: true }); bind(root, holder);
    } else {
      const host = document.createElement('cloud-sync');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><button type="button" class="fab" data-c="open" data-s="loading" aria-haspopup="dialog">${ICON}<i class="dot"></i></button>` +
        `<div class="wrap"><div class="ov" data-c="close"></div><div class="sh" role="dialog" aria-modal="true" aria-label="Облачное сохранение"><div class="grab"></div><div class="pn"></div></div></div><div class="toast" role="status"></div>`;
      document.body.appendChild(host);
      fabRoot = root; roots.push({ root, inline: false }); bind(root, host);
      place(host);
    }
    render();
    let t = null; try { t = sessionStorage.getItem(TOAST); sessionStorage.removeItem(TOAST); } catch (e) {}
    if (t) setTimeout(() => toast(t), 300);
  }

  const gst = document.createElement('style');
  gst.textContent = 'cloud-sync{position:fixed;top:0;left:0;width:0;height:0;z-index:5}cloud-sync.open{z-index:2147483000}@media print{cloud-sync,[data-cloud-panel]{display:none!important}}';
  (document.head || document.documentElement).appendChild(gst);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  boot();

  window.CloudSync = {
    sync: () => sync(true),
    get status() { return user ? status : phase === 'ready' ? 'out' : phase; },
    get user() { return user ? (user.email || user.uid) : null; },
    _t: { split, join, hash, chunks }
  };
})();
