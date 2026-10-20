# Zeus Engine — app de escritorio (cáscara Electron)

Ventana de escritorio del panel local de Cadev2 / Rider-X para la PC del local.

- **La app** (panel, motor ZeusX, kiosk) **no vive acá**: se carga desde
  `https://pwa-panel-local.netlify.app` (repo `Cadev2`), así que cada push a
  Cadev2 llega solo al reiniciar.
- **Esta cáscara** maneja lo que el navegador no puede: dos pantallas
  (principal + kiosk de la sala), foco del teclado numérico del kiosk,
  impresión silenciosa de comandas, borrar caché y cierre seguro.

## Desarrollo
```
npm install
npm start          # corre la app
npm run dist       # genera el instalador en dist/
```
