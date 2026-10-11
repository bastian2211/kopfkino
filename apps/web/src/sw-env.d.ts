// Von vite-plugin-pwa beim Bauen eingesetzte Liste der vorzuladenden Dateien
declare interface ServiceWorkerGlobalScope {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;
}
