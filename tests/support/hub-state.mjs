// Serialize the same critical section that the real Durable Object gates.
export function hubState(records = new Map()) {
  let pending = Promise.resolve();
  return {
    storage: {
      async get(key) { return structuredClone(records.get(key)); },
      async put(key, value) { records.set(key, structuredClone(value)); }
    },
    blockConcurrencyWhile(callback) {
      const result = pending.then(callback);
      pending = result.catch(() => {});
      return result;
    }
  };
}
