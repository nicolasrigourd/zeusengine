const path                                             = require("path");
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const { autoUpdater } = require("electron-updater");

const APP_URL    = "https://pwa-panel-local.netlify.app";
const PRELOAD    = path.join(__dirname, "preload.js");

// ── Single instance lock ───────────────────────────────────────────────────────
// Sin esto, cerrar la ventana visible no mata el proceso (queda la ventana de
// impresión oculta viva) y volver a abrir la app lanza un SEGUNDO proceso que
// pelea por los mismos archivos de IndexedDB/LevelDB que el primero todavía
// tiene abiertos — eso es lo que rompe login/pedidos/repartidores de golpe.
// Con el lock, si ya hay una instancia corriendo (visible o zombie), esta
// nueva se cierra sola y la de antes pasa a primer plano.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Permite que QZ Tray (fallback) funcione desde HTTPS si alguien lo usa por browser.
app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  if (url.startsWith("wss://localhost") || url.startsWith("ws://localhost")) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// ── Fallback de "sin conexión" ────────────────────────────────────────────────
// Si loadURL falla (sin internet, DNS caído, Netlify no responde), Electron
// por defecto muestra la pantalla de error genérica de Chromium — sin avisar
// qué pasó ni qué hacer. Esto es crítico en el primer arranque de una PC
// nueva, donde todavía no hay nada cacheado por el Service Worker: si no hay
// red en ese momento, sin este fallback la ventana queda en blanco/error sin
// ninguna explicación, y nadie se entera de que hace falta conexión.
//
// `ERR_ABORTED` (-3) se ignora: lo dispara Electron normalmente cuando una
// navegación se cancela porque se pidió otra antes de que termine (p.ej. al
// reintentar) — no es un fallo real de conexión.

function attachOfflineFallback(win, targetUrl) {
  win.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED — navegación cancelada, no es un fallo real
    if (validatedURL && validatedURL.startsWith("file://")) return; // evita loop si falla el propio fallback

    console.warn("[OFFLINE_FALLBACK] Falló la carga:", { errorCode, errorDescription, validatedURL });
    win.loadFile(path.join(__dirname, "offline-fallback.html"), {
      query: { target: targetUrl },
    });
  });
}

// ── Ventana principal (panel del operador) ────────────────────────────────────

function agregarF11Toggle(win) {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
    }
  });
}

function crearVentanaPrincipal(display) {
  const { x, y } = display.bounds;
  const win = new BrowserWindow({
    x,
    y,
    width:           1280,
    height:          800,
    minWidth:        1024,
    minHeight:       600,
    fullscreen:      true,
    title:           "Zeus Engine — Operador",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      preload:          PRELOAD,
      // El panel (validación de ingreso) y el motor ZeusX corren en esta
      // ventana: tienen que responder a tiempo aunque no esté a la vista.
      backgroundThrottling: false,
    },
  });

  const url = APP_URL + "/home";
  attachOfflineFallback(win, url);
  win.loadURL(url);
  agregarF11Toggle(win);
  return win;
}

// ── Ventana kiosk (sala de espera — segundo monitor) ──────────────────────────

let kioskWin = null;   // referencia viva — permite reposicionarla/reactivarla sin reiniciar la app

function crearVentanaKiosk(display) {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    title:           "Zeus Engine — Sala de Espera",
    frame:           false,
    kiosk:           true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      preload:          PRELOAD,
      backgroundThrottling: false,
    },
  });

  // ?kiosk=1 distingue la ventana real del monitor 2 de cuando el operador
  // navega a /admin como preview desde el Navbar — así "Vista Sala" puede
  // mostrar un botón de volver que en el monitor 2 real no debe aparecer.
  const url = APP_URL + "/admin?kiosk=1";
  attachOfflineFallback(win, url);
  win.webContents.on("did-finish-load", () => enfocarKiosk());
  win.loadURL(url);
  return win;
}

// Encuentra el monitor secundario actual (puede haber cambiado de id si se
// reconectó un cable, etc.) — siempre resuelve contra la pantalla real ahora.
function obtenerDisplaySecundario() {
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  return displays.find((d) => d.id !== primary.id) || null;
}

// "Activar pantalla 2": si no existe la ventana (o se destruyó), la crea.
// Si ya existe pero quedó minimizada, movida o sacada del monitor 2 por
// cualquier motivo (minimizar la app, Win+D, arrastrarla a mano, etc.), la
// restaura y la vuelve a posicionar exactamente sobre el monitor secundario
// en vez de obligar a reiniciar toda la app para recuperarla.
function activarKiosk() {
  const secondary = obtenerDisplaySecundario();
  if (!secondary) return { ok: false, reason: "no_secondary_display" };

  if (!kioskWin || kioskWin.isDestroyed()) {
    kioskWin = crearVentanaKiosk(secondary);
  } else {
    if (kioskWin.isMinimized()) kioskWin.restore();
    kioskWin.setBounds(secondary.bounds);
    kioskWin.setKiosk(true);
    kioskWin.show();
    kioskWin.focus();
  }
  return { ok: true, active: true };
}

function desactivarKiosk() {
  if (kioskWin && !kioskWin.isDestroyed()) kioskWin.hide();
  return { ok: true, active: false };
}

// ── Ventana de impresión persistente ─────────────────────────────────────────
// Se crea una sola vez al arrancar y se reutiliza en cada trabajo de impresión.
// Evita el costo de new BrowserWindow() + getPrintersAsync() por cada comanda.

let printWin         = null;   // ventana persistente (hidden)
let cachedPrinter    = "";     // nombre de la impresora predeterminada (cacheado)
let printQueue       = [];     // cola para trabajos que llegan mientras se imprime
let printBusy        = false;  // true mientras hay un trabajo en curso

function crearVentanaImpresion() {
  const win = new BrowserWindow({
    show:           false,
    skipTaskbar:    true,
    webPreferences: { contextIsolation: true },
  });
  // Si el renderer crashea, recrear la ventana automáticamente
  win.webContents.on("render-process-gone", () => {
    printWin = null;
    crearVentanaImpresion();
  });
  printWin = win;
}

async function resolverImpresora(printerName) {
  if (printerName) return printerName;
  if (cachedPrinter) return cachedPrinter;
  try {
    if (!printWin || printWin.isDestroyed()) crearVentanaImpresion();
    const printers  = await printWin.webContents.getPrintersAsync();
    const def       = printers.find((p) => p.isDefault) || printers[0];
    cachedPrinter   = def?.name || "";
  } catch {
    cachedPrinter = "";
  }
  return cachedPrinter;
}

function ejecutarTrabajoPrint({ htmlContent, deviceName, resolve, reject }) {
  if (!printWin || printWin.isDestroyed()) crearVentanaImpresion();

  const encoded = encodeURIComponent(htmlContent);

  const onLoad = () => {
    const options = {
      silent:          true,
      printBackground: true,
      margins:         { marginType: "none" },
      ...(deviceName ? { deviceName } : {}),
    };
    printWin.webContents.print(options, (success, reason) => {
      // Limpiar contenido sin destruir la ventana
      printWin.webContents.loadURL("about:blank").catch(() => {});
      printBusy = false;
      if (success) resolve({ ok: true });
      else         reject(new Error(reason || "Error al imprimir"));
      // Procesar siguiente trabajo en cola (si hay)
      if (printQueue.length > 0) {
        const siguiente = printQueue.shift();
        printBusy = true;
        ejecutarTrabajoPrint(siguiente);
      }
    });
  };

  const onFail = (e, code, desc) => {
    printWin.webContents.loadURL("about:blank").catch(() => {});
    printBusy = false;
    reject(new Error(`No se pudo cargar el contenido: ${desc}`));
    if (printQueue.length > 0) {
      const siguiente = printQueue.shift();
      printBusy = true;
      ejecutarTrabajoPrint(siguiente);
    }
  };

  printWin.webContents.once("did-finish-load", onLoad);
  printWin.webContents.once("did-fail-load",   onFail);
  printWin.webContents.loadURL("data:text/html;charset=UTF-8," + encoded);
}

// ── IPC: lista de impresoras ──────────────────────────────────────────────────

ipcMain.handle("get-printers", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const printers = await win.webContents.getPrintersAsync();
  return printers.map((p) => ({
    name:        p.name,
    displayName: p.displayName || p.name,
    isDefault:   p.isDefault,
  }));
});

// ── IPC: imprimir comanda ─────────────────────────────────────────────────────

ipcMain.handle("print-comanda", async (event, { htmlContent, printerName }) => {
  const deviceName = await resolverImpresora(printerName);
  return new Promise((resolve, reject) => {
    const trabajo = { htmlContent, deviceName, resolve, reject };
    if (printBusy) {
      printQueue.push(trabajo);
    } else {
      printBusy = true;
      ejecutarTrabajoPrint(trabajo);
    }
  });
});

// ── IPC: borrar caché/storage y reiniciar ─────────────────────────────────────
// Usa la API de Electron (no borrado manual de carpetas) para que la limpieza
// quede prolija a nivel interno de Chromium — el borrado manual de carpetas
// sueltas puede dejar corrupta la base de cuotas (quota_database) y romper
// IndexedDB/Firestore por completo hasta limpiar todo el perfil a mano.

ipcMain.handle("clear-cache-and-restart", async () => {
  const ses = session.defaultSession;
  await ses.clearStorageData();
  await ses.clearCache();
  app.relaunch();
  // app.quit() (no app.exit()) — deja que Electron cierre todas las ventanas
  // (incluida la de impresión oculta) de forma ordenada antes de salir, para
  // no competir por los mismos archivos de storage con el proceso relanzado.
  app.quit();
});

// ── IPC: cierre seguro de la app ───────────────────────────────────────────────
// Pensado para el botón "Cerrar app" del Navbar (visible solo sin sesión
// logueada). Antes de cerrar, espera a que termine cualquier trabajo de
// impresión en curso — así no se corta una comanda a la mitad.

ipcMain.handle("get-pending-print-status", async () => {
  return { printing: printBusy, queued: printQueue.length };
});

ipcMain.handle("safe-quit", async () => {
  const start = Date.now();
  const TIMEOUT_MS = 15000;
  while ((printBusy || printQueue.length > 0) && Date.now() - start < TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  app.quit();
});

// ── IPC: pantalla 2 (kiosk) ────────────────────────────────────────────────────
// Botón "Pantalla 2" del Navbar — reactiva/reposiciona la ventana del segundo
// monitor sin tener que cerrar y volver a abrir toda la app.

ipcMain.handle("kiosk-status", () => {
  return {
    hasSecondaryDisplay: Boolean(obtenerDisplaySecundario()),
    active: Boolean(kioskWin && !kioskWin.isDestroyed() && kioskWin.isVisible()),
  };
});

ipcMain.handle("kiosk-toggle", () => {
  const activa = Boolean(kioskWin && !kioskWin.isDestroyed() && kioskWin.isVisible());
  return activa ? desactivarKiosk() : activarKiosk();
});

// ── Foco: el kiosk es el dueño del teclado ──────────────────────────────────
// En la sala hay un teclado numérico para que los repartidores se anoten; en
// esta PC solo corre Zeus. Windows le manda TODAS las teclas a la ventana con
// foco y no distingue teclados, así que:
//   - Al arrancar, el foco va al kiosk.
//   - Si el operador usa la principal (mouse sobre ella o teclado), la usa
//     normal, con el teclado completo (numpad incluido).
//   - Sin actividad del operador por FOCO_INACTIVIDAD_MS, el foco vuelve al
//     kiosk (FOCO_FORMULARIO_MS si está escribiendo en un formulario).
//   - Si llega una tecla del numpad a la principal y nadie la está usando,
//     es un repartidor: la tecla va al kiosk y el foco pasa ahí al instante.

const FOCO_INACTIVIDAD_MS = 3000;
const FOCO_FORMULARIO_MS  = 15000;
const FOCO_CHEQUEO_MS     = 500;

const NUMPAD_DIGITS = new Set([
  "Numpad0","Numpad1","Numpad2","Numpad3","Numpad4",
  "Numpad5","Numpad6","Numpad7","Numpad8","Numpad9",
]);

// ¿Hay un campo de formulario activo en la principal? (el input de ID del
// panel, #cadete-id, no cuenta: siempre tiene el foco dentro de la página)
const SCRIPT_EN_FORMULARIO = `(() => {
  const a = document.activeElement;
  if (!a || a.id === "cadete-id") return false;
  if (a.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.readOnly && !a.disabled;
})()`;

function kioskDisponible() {
  return Boolean(kioskWin && !kioskWin.isDestroyed() && kioskWin.isVisible());
}

function enfocarKiosk() {
  if (!kioskDisponible()) return;
  kioskWin.focus();
  kioskWin.webContents.focus();
}

function teclaNumpadParaKiosk(input) {
  if (NUMPAD_DIGITS.has(input.code))   return input.key;    // "0"–"9"
  if (input.code === "NumpadEnter")    return "Return";
  if (input.code === "NumpadDecimal")  return "Backspace";  // punto del numpad = borrar
  return null;
}

function instalarGestorFoco(mainWin) {
  let ultimaActividad = Date.now();
  let ultimoCursor    = null;

  mainWin.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const keyCode = teclaNumpadParaKiosk(input);
    const operadorInactivo = Date.now() - ultimaActividad >= FOCO_INACTIVIDAD_MS;

    if (keyCode && operadorInactivo && kioskDisponible()) {
      // Nadie usa la principal → es un repartidor en el numpad de la sala
      event.preventDefault();
      kioskWin.webContents.sendInputEvent({ type: "keyDown", keyCode });
      kioskWin.webContents.sendInputEvent({ type: "keyUp",   keyCode });
      enfocarKiosk();
      return;
    }

    ultimaActividad = Date.now();
  });

  // Clic / Alt+Tab hacia la principal = el operador la quiere usar
  mainWin.on("focus", () => { ultimaActividad = Date.now(); });

  const timer = setInterval(async () => {
    if (mainWin.isDestroyed()) { clearInterval(timer); return; }
    if (!kioskDisponible()) return;

    // Mouse moviéndose sobre la principal = actividad del operador
    const cursor = screen.getCursorScreenPoint();
    const b      = mainWin.getBounds();
    const movio  = ultimoCursor && (cursor.x !== ultimoCursor.x || cursor.y !== ultimoCursor.y);
    ultimoCursor = cursor;
    if (movio && cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) {
      ultimaActividad = Date.now();
    }

    const enfocada = BrowserWindow.getFocusedWindow();
    if (enfocada === kioskWin) return;

    let limite = FOCO_INACTIVIDAD_MS;
    if (enfocada === mainWin) {
      const enFormulario = await mainWin.webContents
        .executeJavaScript(SCRIPT_EN_FORMULARIO, true)
        .catch(() => false);
      if (enFormulario) limite = FOCO_FORMULARIO_MS;
    }

    if (Date.now() - ultimaActividad >= limite) enfocarKiosk();
  }, FOCO_CHEQUEO_MS);
}

// RESERVA: reenvío viejo — copiaba el numpad de la principal al kiosk sin
// sacárselo a la principal (el ID se procesaba dos veces). Reemplazado por
// instalarGestorFoco. Se conserva para análisis/rollback.
// eslint-disable-next-line no-unused-vars
function reenviarNumpadAlKiosk(mainWin, kioskWin) {
  mainWin.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown")              return;
    if (!kioskWin || kioskWin.isDestroyed())   return;

    let keyCode = null;
    if (NUMPAD_DIGITS.has(input.code))         keyCode = input.key;        // "0"–"9"
    else if (input.code === "NumpadEnter")     keyCode = "Return";
    else if (input.code === "NumpadDecimal")   keyCode = "Backspace";      // punto del numpad = borrar

    if (!keyCode) return;

    kioskWin.webContents.sendInputEvent({ type: "keyDown", keyCode });
    kioskWin.webContents.sendInputEvent({ type: "keyUp",   keyCode });
  });
}

// ── Actualizaciones automáticas de la cáscara ────────────────────────────────
// La APP (Cadev2) se actualiza sola desde Netlify en cada arranque. Esto
// actualiza la CÁSCARA (este main.js, preload, etc.) desde GitHub Releases
// (repo nicolasrigourd/zeusengine): busca al arrancar y cada 6 h, descarga en
// segundo plano y se instala al cerrar Zeus (o al próximo reinicio de la PC).
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

function iniciarActualizaciones() {
  if (!app.isPackaged) return; // en desarrollo (npm start) no hay nada que actualizar

  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available",  (info) => console.log("[UPDATER] versión nueva disponible:", info?.version));
  autoUpdater.on("update-downloaded", (info) => console.log("[UPDATER] descargada, se instala al cerrar:", info?.version));
  autoUpdater.on("error",             (err)  => console.warn("[UPDATER] error:", err?.message));

  const buscar = () => autoUpdater.checkForUpdates().catch((err) => console.warn("[UPDATER] no se pudo buscar:", err?.message));
  buscar();
  setInterval(buscar, UPDATE_CHECK_MS);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

let mainWindowRef = null;

// Si ya hay una instancia corriendo (visible o "zombie" en segundo plano) y el
// operador intenta abrir la app de nuevo, en vez de lanzar un segundo proceso
// que pelee por los mismos archivos de storage, enfocamos la ventana existente.
app.on("second-instance", () => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    if (mainWindowRef.isMinimized()) mainWindowRef.restore();
    mainWindowRef.focus();
  }
});

app.whenReady().then(() => {
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();

  // Pre-crear la ventana de impresión y cachear la impresora predeterminada
  // antes de que llegue el primer trabajo — elimina el delay por creación lazy.
  crearVentanaImpresion();
  resolverImpresora("").catch(() => {});

  const mainWin = crearVentanaPrincipal(primary);
  mainWindowRef = mainWin;

  if (displays.length >= 2) {
    const secondary = displays.find(d => d.id !== primary.id);
    kioskWin        = crearVentanaKiosk(secondary);
  }

  // Se instala siempre: si el kiosk se activa después ("Pantalla 2"),
  // el gestor lo toma de la variable global kioskWin.
  instalarGestorFoco(mainWin);

  iniciarActualizaciones();

  // Cerrar la ventana principal (Alt+F4, único modo de cierre disponible en
  // fullscreen sin barra de título) es la señal real de "quiero cerrar la
  // app". Antes esto NO mataba el proceso porque la ventana de impresión
  // oculta seguía viva y window-all-closed nunca llegaba a cero — la app
  // quedaba corriendo invisible, y la siguiente apertura lanzaba un segundo
  // proceso que pisaba los mismos locks de IndexedDB/LevelDB del primero.
  mainWin.on("closed", () => {
    mainWindowRef = null;
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const p = screen.getPrimaryDisplay();
      const w = crearVentanaPrincipal(p);
      mainWindowRef = w;
      w.on("closed", () => { mainWindowRef = null; app.quit(); });
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
