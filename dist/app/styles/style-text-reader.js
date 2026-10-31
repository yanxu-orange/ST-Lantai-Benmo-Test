class StyleResponseError extends Error {}

// One presentation owner shares raw resources, while each consumer keeps its
// own cascade, asset resolution and error wording. Never cache host data here.
export function createStyleTextReader(request) {
  const pending = new Map();
  let disposed = false;
  return {
    read(url, unavailableMessage = '') {
      if (disposed) return Promise.reject(new Error('样式读取已结束'));
      const key = new URL(url).href;
      let attempt = pending.get(key);
      if (!attempt) {
        attempt = Promise.resolve().then(async () => {
          const response = await request(url);
          if (!response.ok) throw new StyleResponseError();
          return response.text();
        }).catch(error => {
          if (pending.get(key) === attempt) pending.delete(key);
          throw error;
        });
        pending.set(key, attempt);
      }
      return attempt.catch(error => {
        if (error instanceof StyleResponseError) throw new Error(unavailableMessage);
        throw error;
      });
    },
    dispose() { disposed = true; pending.clear(); },
  };
}
