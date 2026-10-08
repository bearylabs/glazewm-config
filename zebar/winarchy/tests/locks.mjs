export function testLocks() {
  const queues = new Map();
  return {
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (queues.has(name) && options.ifAvailable) return Promise.resolve().then(() => callback(null));
      const previous = queues.get(name) ?? Promise.resolve();
      const result = previous.then(async () => {
        return callback({ name });
      });
      const tail = result.then(() => {}, () => {}).finally(() => {
        if (queues.get(name) === tail) queues.delete(name);
      });
      queues.set(name, tail);
      return result;
    },
  };
}
