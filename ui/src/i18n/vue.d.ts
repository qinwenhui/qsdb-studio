import type { t } from './index'

declare module 'vue' {
  interface ComponentCustomProperties {
    /** Translate a Chinese source string (English lookup with Chinese fallback). */
    $t: typeof t
  }
}

export {}
