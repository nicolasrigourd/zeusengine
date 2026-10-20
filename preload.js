const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  print:                 (htmlContent, printerName) => ipcRenderer.invoke("print-comanda", { htmlContent, printerName }),
  getPrinters:           ()                         => ipcRenderer.invoke("get-printers"),
  clearCacheAndRestart:  ()                         => ipcRenderer.invoke("clear-cache-and-restart"),
  getPendingPrintStatus: ()                         => ipcRenderer.invoke("get-pending-print-status"),
  safeQuit:              ()                         => ipcRenderer.invoke("safe-quit"),
  getKioskStatus:        ()                         => ipcRenderer.invoke("kiosk-status"),
  toggleKiosk:           ()                         => ipcRenderer.invoke("kiosk-toggle"),
});
