
'use strict';

/**
 * Sets the number on the app icon (Badging API: installed web apps, including iOS/iPadOS home-screen
 * apps, where it is the only way to show that notifications were read, see library.js).
 */
async function webPushSetBadge(count) {
	if (typeof count !== 'number' || !self.navigator || !self.navigator.setAppBadge) {
		return;
	}
	try {
		await (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge());
	} catch (e) {
		// not allowed or not supported here – nothing to do
	}
}

/**
 * Closes the notifications currently shown on this device that are no longer unread
 * on the forum (e.g. they were read on another device), keeping `exceptTag` open.
 *
 * Runs when a new push arrives and when an open forum page asks for it (see public/lib/main.js).
 * It never sends a push by itself. On iOS/iPadOS closing has no effect (see library.js), but the
 * same request also brings the unread count for the app icon badge.
 */
async function webPushCloseReadNotifications(exceptTag) {
	if (!self.registration.getNotifications) {
		return;
	}

	// Only notifications created by this plugin carry a tag and a target url. Even with none shown
	// the count is fetched: core sets the app icon badge only when the count changes while a page is
	// open, so a badge left from an earlier push (e.g. "1" after the notification was read on another
	// device, or its banner was swiped away on iOS) would otherwise stay until the next push.
	const shown = (await self.registration.getNotifications())
		.filter(n => n.tag && n.tag !== exceptTag && n.data && n.data.url);

	let tags;
	let count;
	try {
		const res = await fetch(new URL('api/v3/plugins/web-push/unread-tags', self.registration.scope), {
			credentials: 'same-origin',
			cache: 'no-store',
			headers: { accept: 'application/json' },
		});
		if (!res.ok) {
			return; // e.g. logged out or offline – leave everything as is
		}
		({ tags, count } = (await res.json()).response || {});
	} catch (e) {
		return;
	}
	await webPushSetBadge(count);
	if (!Array.isArray(tags)) {
		return;
	}

	const unread = new Set(tags.map(String));
	shown.forEach((notification) => {
		if (!unread.has(String(notification.tag))) {
			notification.close();
		}
	});
}

// Register event listener for the 'push' event.
self.addEventListener('push', (event) => {
	// Keep the service worker alive until the notification is created.
	const { title, body, tag, data, actions, unread } = event.data.json();

	if (title && body) {
		const { icon } = data;
		delete data.icon;
		const { badge } = data;
		delete data.badge;
		const options = { body, tag, data, icon, badge };

		// Action buttons are not supported everywhere (e.g. Firefox, Safari);
		// Notification.maxActions only exists where they are.
		if (Array.isArray(actions) && typeof Notification !== 'undefined' &&
			'maxActions' in Notification && Notification.maxActions > 0) {
			options.actions = actions.slice(0, Notification.maxActions);
		}

		event.waitUntil(Promise.all([
			self.registration.showNotification(title, options)
				.then(() => webPushCloseReadNotifications(tag).catch(() => {})),
			webPushSetBadge(unread),
		]));
	} else if (tag) {
		event.waitUntil(
			self.registration.getNotifications({ tag }).then((notifications) => {
				notifications.forEach((notification) => {
					notification.close();
				});
			})
		);
	}
});

// Marks a notification read directly against the API. Push notifications are
// usually acted on when no forum window is open, so this cannot rely on
// postMessage to a client — the session cookie and a freshly-fetched csrf
// token are enough to call the write API from the worker itself.
async function markNotificationRead(nid) {
	const base = self.registration.scope;

	const configRes = await fetch(new URL('api/config', base), { credentials: 'same-origin' });
	if (!configRes.ok) {
		return;
	}
	const { csrf_token: csrfToken } = await configRes.json();

	await fetch(new URL(`api/v3/notifications/${encodeURIComponent(nid)}/read`, base), {
		method: 'PUT',
		credentials: 'same-origin',
		headers: { 'x-csrf-token': csrfToken },
	});
}

// Focuses an existing forum window (navigating it via ajaxify) or opens a new one.
function focusOrOpen(target) {
	return self.clients
		.matchAll({ type: 'window' })
		.then((clientList) => {
			for (const client of clientList) {
				const { hostname } = new URL(client.url);
				if (target && hostname === target.hostname && 'focus' in client) {
					client.postMessage({
						action: 'ajaxify',
						url: target.pathname,
					});
					return client.focus();
				}
			}
			if (target && self.clients.openWindow) return self.clients.openWindow(target.pathname);
		});
}

// An open forum page asks us to sync (after navigation, when it becomes visible,
// or when the unread notification count changes)
self.addEventListener('message', (event) => {
	if (event.data && event.data.action === 'web-push:sync') {
		event.waitUntil(webPushCloseReadNotifications().catch(() => {}));
	}
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();

	if (event.action === 'mark-read') {
		const nid = event.notification.data && event.notification.data.nid;
		if (nid) {
			event.waitUntil(markNotificationRead(nid).catch(() => {}));
		}
		return;
	}

	if (event.action === 'view-notifications') {
		event.waitUntil(focusOrOpen(new URL('notifications', self.registration.scope)));
		return;
	}

	let target;
	if (event.notification.data && event.notification.data.url) {
		target = new URL(event.notification.data.url);
	}

	// This looks to see if the current is already open and focuses if it is
	event.waitUntil(focusOrOpen(target));
});
