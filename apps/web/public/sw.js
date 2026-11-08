// Push notifications: short, plain text; opening one goes straight to the right page.
self.addEventListener('push', (event) => {
  let data = { title: 'Update', body: '', url: '/app' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain text */
  }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: data.url } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(self.clients.openWindow(url));
});
