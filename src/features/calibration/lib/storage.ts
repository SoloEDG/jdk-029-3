import type { CalibrationRecord } from './types'

const name = 'night-session'
const version = 2
const storeName = 'calibrations'

function connect() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await connect()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode)
      const request = operation(transaction.objectStore(storeName))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export const readCalibrations = () => transact<CalibrationRecord[]>('readonly', store => store.getAll())
export const writeCalibration = (record: CalibrationRecord) => transact('readwrite', store => store.put(record))
