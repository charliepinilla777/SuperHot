import NodeCache from 'node-cache'
import { logger } from './logger'

/**
 * Caché en memoria por proceso.
 *
 * IMPORTANTE PARA ESCALABILIDAD: esto vive en RAM de una sola instancia.
 * Funciona bien con 1 instancia del backend. En cuanto corras 2+ instancias
 * (por ejemplo detrás de un load balancer o en modo cluster de PM2), cada
 * instancia tendrá su propia copia y la invalidación de una no afecta a las
 * otras (datos ligeramente inconsistentes entre instancias, TTL corto lo mitiga).
 * Cuando llegues a ese punto, cambia el `store` interno de este módulo por un
 * cliente de Redis (ioredis) manteniendo la misma interfaz get/set/del/wrap.
 */
const store = new NodeCache({
  stdTTL: 60, // 60s por defecto
  checkperiod: 30,
  useClones: false,
})

export const cache = {
  get<T>(key: string): T | undefined {
    return store.get<T>(key)
  },

  set<T>(key: string, value: T, ttlSeconds?: number): void {
    store.set(key, value, ttlSeconds ?? 60)
  },

  del(key: string): void {
    store.del(key)
  },

  /** Invalida todas las keys que empiecen con un prefijo, ej: `creators:` */
  invalidatePrefix(prefix: string): void {
    const keys = store.keys().filter((k) => k.startsWith(prefix))
    if (keys.length) {
      store.del(keys)
      logger.debug('Cache invalidada', { prefix, count: keys.length })
    }
  },

  /** Envuelve una función async: si hay hit devuelve el valor cacheado, si no la ejecuta y cachea el resultado */
  async wrap<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const cached = store.get<T>(key)
    if (cached !== undefined) {
      return cached
    }
    const fresh = await fn()
    store.set(key, fresh, ttlSeconds)
    return fresh
  },

  stats() {
    return store.getStats()
  },
}
