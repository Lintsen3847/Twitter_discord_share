// ==UserScript==
// @name         X 分享到 Discord (fixupx)
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  在 X 分享彈窗加入「分享到 Discord」按鈕，將分享連結轉為 fixupx 後送至 webhook
// @author       Lin_tsen
// @match        *://x.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      discord.com
// @connect      discordapp.com
// @icon         https://cdn.simpleicons.org/discord/5865F2
// @icon64       https://cdn.simpleicons.org/discord/5865F2
// @license      MIT
// ==/UserScript==

(function () {
	'use strict';

	const STORAGE_KEY_WEBHOOK = 'x_discord_webhook_url';
	const DISCORD_BUTTON_KEY = 'discordWebhookButtonInjected';
	const BUTTON_ID = 'x-share-to-discord-button';
	const SHARE_BUTTON_SELECTOR = '[data-testid="share"]';
	const SHARE_BUTTON_ARIA_PATTERN = /share|分享/i;
	const DROPDOWN_SELECTOR = '[data-testid="Dropdown"]';

	let lastSharedPostUrl = '';

	function showToast(message, isError) {
		const toast = document.createElement('div');
		toast.textContent = message;
		toast.style.cssText = [
			'position: fixed',
			'right: 16px',
			'bottom: 16px',
			'z-index: 999999',
			'padding: 10px 14px',
			'border-radius: 10px',
			'font-size: 13px',
			'font-weight: 600',
			'color: #ffffff',
			isError ? 'background: #cf222e' : 'background: #1d9bf0',
			'box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32)',
			'opacity: 0',
			'transform: translateY(8px)',
			'transition: opacity .2s ease, transform .2s ease'
		].join(';');

		document.body.appendChild(toast);

		requestAnimationFrame(() => {
			toast.style.opacity = '1';
			toast.style.transform = 'translateY(0)';
		});

		setTimeout(() => {
			toast.style.opacity = '0';
			toast.style.transform = 'translateY(8px)';
			setTimeout(() => toast.remove(), 220);
		}, 2200);
	}

	function normalizeWebhookUrl(input) {
		const value = String(input || '').trim();
		if (!value) {
			return '';
		}

		try {
			const url = new URL(value);
			const isDiscordHost = url.hostname === 'discord.com' || url.hostname === 'discordapp.com';
			const hasWebhookPath = /^\/api\/webhooks\//.test(url.pathname);
			if (!isDiscordHost || !hasWebhookPath) {
				return '';
			}
			return url.toString();
		} catch (error) {
			return '';
		}
	}

	function getWebhookUrl() {
		return normalizeWebhookUrl(localStorage.getItem(STORAGE_KEY_WEBHOOK));
	}

	function setWebhookUrl(url) {
		localStorage.setItem(STORAGE_KEY_WEBHOOK, url);
	}

	function clearWebhookUrl() {
		localStorage.removeItem(STORAGE_KEY_WEBHOOK);
	}

	function registerMenuCommands() {
		GM_registerMenuCommand('設定 Discord Webhook', () => {
			const current = getWebhookUrl();
			const input = window.prompt('請貼上 Discord Webhook URL：', current || '');
			if (input === null) {
				return;
			}

			const normalized = normalizeWebhookUrl(input);
			if (!normalized) {
				showToast('Webhook 格式無效，請檢查網址', true);
				return;
			}

			setWebhookUrl(normalized);
			showToast('Discord Webhook 已儲存', false);
		});

		GM_registerMenuCommand('清除 Discord Webhook', () => {
			clearWebhookUrl();
			showToast('Discord Webhook 已清除', false);
		});
	}

	function convertToFixupx(urlText) {
		try {
			const url = new URL(urlText);
			if (url.hostname === 'x.com') {
				url.hostname = 'fixupx.com';
			}
			return url.toString();
		} catch (error) {
			return '';
		}
	}

	function getPostUrlFromArticle(article) {
		if (!article) {
			return '';
		}

		const statusLinks = article.querySelectorAll('a[href*="/status/"]');
		let selected = null;

		statusLinks.forEach((link) => {
			if (!selected && link.querySelector('time')) {
				selected = link;
			}
		});

		if (!selected && statusLinks.length > 0) {
			selected = statusLinks[0];
		}

		if (!selected) {
			return '';
		}

		try {
			const url = new URL(selected.getAttribute('href'), location.origin);
			if (!url.searchParams.has('s')) {
				url.searchParams.set('s', '20');
			}
			return url.toString();
		} catch (error) {
			return '';
		}
	}

	function getFallbackPostUrlFromPage() {
		const candidateLinks = Array.from(document.querySelectorAll('a[href*="/status/"]'));
		let selected = null;

		candidateLinks.forEach((link) => {
			if (!selected && link.querySelector('time')) {
				selected = link;
			}
		});

		if (!selected && candidateLinks.length > 0) {
			selected = candidateLinks[0];
		}

		if (!selected) {
			return '';
		}

		try {
			const url = new URL(selected.getAttribute('href'), location.origin);
			if (!url.searchParams.has('s')) {
				url.searchParams.set('s', '20');
			}
			return url.toString();
		} catch (error) {
			return '';
		}
	}

	function getBestShareUrl() {
		if (lastSharedPostUrl) {
			return lastSharedPostUrl;
		}

		const pageFallback = getFallbackPostUrlFromPage();
		if (pageFallback) {
			return pageFallback;
		}

		try {
			const current = new URL(location.href);
			if (/\/status\//.test(current.pathname)) {
				if (!current.searchParams.has('s')) {
					current.searchParams.set('s', '20');
				}
				return current.toString();
			}
		} catch (error) {
			return '';
		}

		return '';
	}

	function getEventPath(event) {
		if (typeof event.composedPath === 'function') {
			return event.composedPath();
		}

		const path = [];
		let current = event.target;
		while (current) {
			path.push(current);
			current = current.parentNode;
		}
		path.push(window);
		return path;
	}

	function findShareTriggerInPath(path) {
		for (const node of path) {
			if (!(node instanceof Element)) {
				continue;
			}

			if (node.matches(SHARE_BUTTON_SELECTOR)) {
				return node;
			}

			if (node.querySelector && node.querySelector(SHARE_BUTTON_SELECTOR)) {
				return node;
			}

			const ariaLabel = node.getAttribute('aria-label') || '';
			if (node.tagName === 'BUTTON' && SHARE_BUTTON_ARIA_PATTERN.test(ariaLabel)) {
				return node;
			}
		}

		return null;
	}

	function findArticleInPath(path) {
		for (const node of path) {
			if (!(node instanceof Element)) {
				continue;
			}

			const article = node.closest('article');
			if (article) {
				return article;
			}
		}

		return null;
	}

	function postToDiscord(webhookUrl, sharedUrl) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: 'POST',
				url: webhookUrl,
				headers: {
					'Content-Type': 'application/json'
				},
				data: JSON.stringify({
					content: sharedUrl
				}),
				onload: (response) => {
					if (response.status >= 200 && response.status < 300) {
						resolve();
						return;
					}
					reject(new Error(`Webhook HTTP ${response.status}`));
				},
				onerror: () => {
					reject(new Error('網路錯誤'));
				},
				ontimeout: () => {
					reject(new Error('請求逾時'));
				},
				timeout: 12000
			});
		});
	}

	function createDiscordButton(templateItem) {
		const item = document.createElement('div');
		item.id = BUTTON_ID;
		item.dataset.discordAction = '1';
		item.setAttribute('role', 'menuitem');
		item.tabIndex = 0;
		item.className = templateItem.className;

		const templateIconContainer = templateItem.children[0];
		const templateTextOuter = templateItem.children[1];
		const templateTextInner = templateTextOuter ? templateTextOuter.firstElementChild : null;
		const templateSpan = templateTextInner ? templateTextInner.querySelector('span') : null;

		const iconContainer = document.createElement('div');
		iconContainer.className = templateIconContainer ? templateIconContainer.className : '';
		iconContainer.innerHTML = [
			'<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-1xvli5t r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-1nao33i r-1q142lx">',
			'<g>',
			'<path d="M19.54 5.34A16.4 16.4 0 0 0 15.5 4l-.2.4a15.1 15.1 0 0 1 3.66 1.25 12.48 12.48 0 0 0-3.6-1.11 11.53 11.53 0 0 0-6.72 0A12.48 12.48 0 0 0 5.04 5.65 15.1 15.1 0 0 1 8.7 4.4L8.5 4a16.4 16.4 0 0 0-4.04 1.34C1.9 9.16 1.2 12.88 1.55 16.55A16.5 16.5 0 0 0 6.5 19l.6-.98a10.6 10.6 0 0 1-1.64-.8l.14-.1c3.16 1.48 6.58 1.48 9.7 0l.15.1a10.6 10.6 0 0 1-1.65.8l.6.98a16.5 16.5 0 0 0 4.95-2.45c.42-4.26-.72-7.95-3.81-11.21ZM9.75 14.3c-.96 0-1.75-.9-1.75-2s.77-2 1.75-2c.97 0 1.76.9 1.75 2 0 1.1-.78 2-1.75 2Zm4.5 0c-.97 0-1.75-.9-1.75-2s.78-2 1.75-2 1.75.9 1.75 2-.78 2-1.75 2Z"></path>',
			'</g>',
			'</svg>'
		].join('');

		const textOuter = document.createElement('div');
		textOuter.className = templateTextOuter ? templateTextOuter.className : '';

		const textInner = document.createElement('div');
		textInner.setAttribute('dir', 'ltr');
		textInner.className = templateTextInner ? templateTextInner.className : '';
		if (templateTextInner && templateTextInner.getAttribute('style')) {
			textInner.setAttribute('style', templateTextInner.getAttribute('style'));
		}

		const label = document.createElement('span');
		label.className = templateSpan ? templateSpan.className : '';
		label.textContent = '分享到 Discord';

		textInner.appendChild(label);
		textOuter.appendChild(textInner);
		item.appendChild(iconContainer);
		item.appendChild(textOuter);

		const runSend = async () => {
			const webhook = getWebhookUrl();
			if (!webhook) {
				showToast('請先在腳本選單設定 Discord Webhook', true);
				return;
			}

			const sourceUrl = getBestShareUrl();
			if (!sourceUrl) {
				showToast('找不到可分享的貼文連結', true);
				return;
			}

			const fixedUrl = convertToFixupx(sourceUrl);
			if (!fixedUrl) {
				showToast('連結轉換失敗', true);
				return;
			}

			document.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true
			}));

			item.style.pointerEvents = 'none';
			item.style.opacity = '0.6';
			const prevText = label ? label.textContent : item.textContent;
			if (label) {
				label.textContent = '傳送中...';
			} else {
				item.textContent = '傳送中...';
			}

			try {
				await postToDiscord(webhook, fixedUrl);
				showToast('已分享到 Discord', false);
			} catch (error) {
				showToast(`分享失敗：${error.message}`, true);
			} finally {
				item.style.pointerEvents = 'auto';
				item.style.opacity = '1';
				if (label) {
					label.textContent = prevText;
				} else {
					item.textContent = prevText;
				}
			}
		};

		item.addEventListener('click', runSend);
		item.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				runSend();
			}
		});

		return item;
	}

	function getMenuInsertionPoint(dropdown) {
		if (!dropdown) {
			return null;
		}

		const menuItems = Array.from(dropdown.children).filter((element) => {
			return element instanceof HTMLElement
				&& element.getAttribute('role') === 'menuitem'
				&& element.id !== BUTTON_ID;
		});

		if (menuItems.length === 0) {
			return null;
		}

		const firstMenuItem = menuItems[0];
		const parent = firstMenuItem.parentElement;
		if (!parent) {
			return null;
		}

		return {
			dropdown,
			parent,
			template: firstMenuItem,
			before: firstMenuItem
		};
	}

	function injectDiscordButton(dropdown) {
		if (!dropdown || dropdown.dataset[DISCORD_BUTTON_KEY] === '1') {
			return;
		}

		if (dropdown.querySelector(`#${BUTTON_ID}`)) {
			dropdown.dataset[DISCORD_BUTTON_KEY] = '1';
			return;
		}

		const insertionPoint = getMenuInsertionPoint(dropdown);
		if (!insertionPoint) {
			return;
		}

		const button = createDiscordButton(insertionPoint.template);
		insertionPoint.parent.insertBefore(button, insertionPoint.before);
		dropdown.dataset[DISCORD_BUTTON_KEY] = '1';
	}

	function setupShareContextCapture() {
		document.addEventListener('click', (event) => {
			const path = getEventPath(event);
			const shareButton = findShareTriggerInPath(path);

			if (!shareButton) {
				return;
			}

			const article = shareButton.closest('article') || findArticleInPath(path);
			const postUrl = getPostUrlFromArticle(article);
			if (postUrl) {
				lastSharedPostUrl = postUrl;
				return;
			}

			lastSharedPostUrl = '';
		}, true);
	}

	function setupDialogObserver() {
		const observer = new MutationObserver(() => {
			const dropdowns = document.querySelectorAll(DROPDOWN_SELECTOR);
			dropdowns.forEach((dropdown) => {
				injectDiscordButton(dropdown);
			});
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true
		});

		const existingDropdowns = document.querySelectorAll(DROPDOWN_SELECTOR);
		existingDropdowns.forEach((dropdown) => {
			injectDiscordButton(dropdown);
		});
	}

	function init() {
		registerMenuCommands();
		setupShareContextCapture();
		setupDialogObserver();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
})();
