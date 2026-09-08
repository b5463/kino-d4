const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kinoPrint', {
  openFile: () => ipcRenderer.invoke('file:open'),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  inspectFile: (path) => ipcRenderer.invoke('file:inspect', path),
  listPorts: () => ipcRenderer.invoke('printer:ports'),
  startPrint: (request) => ipcRenderer.invoke('print:start', request),
  sendControl: (action) => ipcRenderer.invoke('print:control', action),
  emergencyCooldown: () => ipcRenderer.invoke('print:emergency-cooldown'),
  acknowledgePowerOff: () => ipcRenderer.invoke('print:acknowledge-power-off'),
  getStatus: () => ipcRenderer.invoke('print:status'),
  showLog: () => ipcRenderer.invoke('print:show-log'),
  showUserGuide: () => ipcRenderer.invoke('help:guide'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
});
