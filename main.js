// ==UserScript==
// @name         X 分享到 Discord (fixupx)
// @namespace    http://tampermonkey.net/
// @version      1.3.0
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

	const STORAGE_KEY_WEBHOOK_ITEMS = 'x_discord_webhook_items';
	const STORAGE_KEY_WEBHOOKS = 'x_discord_webhook_urls';
	const STORAGE_KEY_WEBHOOK = 'x_discord_webhook_url';
	const DISCORD_BUTTON_KEY = 'discordWebhookButtonInjected';
	const BUTTON_ID = 'x-share-to-discord-button';
	const SHARE_BUTTON_SELECTOR = '[data-testid="share"]';
	const SHARE_BUTTON_ARIA_PATTERN = /share|分享/i;
	const DROPDOWN_SELECTOR = '[data-testid="Dropdown"]';
	const CONFIG_MODAL_ID = 'x-discord-webhook-config-modal';
	const DISCORD_ICON_SVG = [
		'<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-1xvli5t r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-1nao33i r-1q142lx">',
		'<path fill="currentColor" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/>',
		'</svg>'
	].join('');

	let lastSharedPostUrl = '';

	function showToast(message, isError) {
		const toast = document.createElement('div');
		toast.className = 'x-discord-toast';
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

	function debounce(fn, ms) {
		let timer = null;
		return (...args) => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				fn(...args);
			}, ms);
		};
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

	function dedupeWebhookUrls(urls) {
		const result = [];
		const seen = new Set();

		urls.forEach((url) => {
			if (!url || seen.has(url)) {
				return;
			}
			seen.add(url);
			result.push(url);
		});

		return result;
	}

	function normalizeWebhookName(input, fallbackName) {
		const cleaned = String(input || '').trim();
		return cleaned || fallbackName;
	}

	function dedupeWebhookItems(items) {
		const result = [];
		const seen = new Set();

		items.forEach((item, index) => {
			if (!item || !item.url) {
				return;
			}

			const url = normalizeWebhookUrl(item.url);
			if (!url || seen.has(url)) {
				return;
			}

			seen.add(url);
			result.push({
				name: normalizeWebhookName(item.name, `Webhook ${index + 1}`),
				url
			});
		});

		return result;
	}

	function getWebhookItems() {
		let items = [];

		try {
			const storedItems = JSON.parse(localStorage.getItem(STORAGE_KEY_WEBHOOK_ITEMS) || '[]');
			if (Array.isArray(storedItems)) {
				items = dedupeWebhookItems(storedItems.map((item, index) => ({
					name: item && item.name,
					url: item && item.url,
					index
				})));
			}
		} catch (error) {
			items = [];
		}

		if (items.length > 0) {
			return items;
		}

		let legacyUrls = [];

		try {
			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_WEBHOOKS) || '[]');
			if (Array.isArray(stored)) {
				legacyUrls = stored
					.map((value) => normalizeWebhookUrl(value))
					.filter(Boolean);
			}
		} catch (error) {
			legacyUrls = [];
		}

		if (legacyUrls.length === 0) {
			const legacyUrl = normalizeWebhookUrl(localStorage.getItem(STORAGE_KEY_WEBHOOK));
			if (legacyUrl) {
				legacyUrls = [legacyUrl];
			}
		}

		legacyUrls = dedupeWebhookUrls(legacyUrls);
		if (legacyUrls.length === 0) {
			return [];
		}

		const migratedItems = legacyUrls.map((url, index) => ({
			name: `Webhook ${index + 1}`,
			url
		}));
		localStorage.setItem(STORAGE_KEY_WEBHOOK_ITEMS, JSON.stringify(migratedItems));
		localStorage.setItem(STORAGE_KEY_WEBHOOKS, JSON.stringify(legacyUrls));
		localStorage.setItem(STORAGE_KEY_WEBHOOK, legacyUrls[0]);

		return migratedItems;
	}

	function setWebhookItems(items) {
		const normalized = dedupeWebhookItems(items);

		if (normalized.length === 0) {
			localStorage.removeItem(STORAGE_KEY_WEBHOOK_ITEMS);
			localStorage.removeItem(STORAGE_KEY_WEBHOOKS);
			localStorage.removeItem(STORAGE_KEY_WEBHOOK);
			return;
		}

		const urls = normalized.map((item) => item.url);
		localStorage.setItem(STORAGE_KEY_WEBHOOK_ITEMS, JSON.stringify(normalized));
		localStorage.setItem(STORAGE_KEY_WEBHOOKS, JSON.stringify(urls));
		// 保留舊版 key 相容
		localStorage.setItem(STORAGE_KEY_WEBHOOK, urls[0]);
	}

	function getWebhookUrls() {
		return getWebhookItems().map((item) => item.url);
	}

	function clearWebhookItems() {
		localStorage.removeItem(STORAGE_KEY_WEBHOOK_ITEMS);
		localStorage.removeItem(STORAGE_KEY_WEBHOOKS);
		localStorage.removeItem(STORAGE_KEY_WEBHOOK);
	}

	function closeWebhookConfigModal() {
		const existing = document.getElementById(CONFIG_MODAL_ID);
		if (existing) {
			existing.remove();
		}
	}

	function openWebhookConfigModal() {
		closeWebhookConfigModal();

		const overlay = document.createElement('div');
		overlay.id = CONFIG_MODAL_ID;
		overlay.style.cssText = [
			'position: fixed',
			'inset: 0',
			'background: rgba(0, 0, 0, 0.62)',
			'z-index: 999999',
			'display: flex',
			'align-items: center',
			'justify-content: center',
			'padding: 16px'
		].join(';');

		const panel = document.createElement('div');
		panel.style.cssText = [
			'width: min(760px, 96vw)',
			'max-height: 90vh',
			'background: #0b1020',
			'border: 1px solid #334155',
			'border-radius: 14px',
			'box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45)',
			'padding: 16px',
			'color: #e2e8f0',
			'display: flex',
			'flex-direction: column',
			'gap: 12px'
		].join(';');

		const title = document.createElement('div');
		title.textContent = 'Discord Webhook 設定';
		title.style.cssText = 'font-size: 16px; font-weight: 700;';

		const subtitle = document.createElement('div');
		subtitle.textContent = '一行一筆設定：可命名並填入 URL。送出時會對所有 Webhook 發送。';
		subtitle.style.cssText = 'font-size: 12px; color: #94a3b8;';

		const list = document.createElement('div');
		list.style.cssText = [
			'width: 100%',
			'min-height: 240px',
			'max-height: 50vh',
			'overflow: auto',
			'padding: 12px',
			'border-radius: 10px',
			'border: 1px solid #475569',
			'background: #020617',
			'color: #e2e8f0',
			'display: flex',
			'flex-direction: column',
			'gap: 8px'
		].join(';');

		const makeInputStyle = (width) => [
			`width: ${width}`,
			'padding: 7px 8px',
			'border-radius: 8px',
			'border: 1px solid #475569',
			'background: #0f172a',
			'color: #e2e8f0',
			'font-size: 12px',
			'outline: none'
		].join(';');

		const addRow = (item) => {
			const row = document.createElement('div');
			row.style.cssText = 'display: grid; grid-template-columns: 170px 1fr auto; gap: 8px; align-items: center;';

			const nameInput = document.createElement('input');
			nameInput.type = 'text';
			nameInput.placeholder = '名稱，例如：主頻道';
			nameInput.value = (item && item.name) || '';
			nameInput.style.cssText = makeInputStyle('100%');

			const urlInput = document.createElement('input');
			urlInput.type = 'text';
			urlInput.placeholder = 'https://discord.com/api/webhooks/...';
			urlInput.value = (item && item.url) || '';
			urlInput.style.cssText = makeInputStyle('100%');

			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.textContent = '刪除';
			removeBtn.style.cssText = [
				'padding: 7px 10px',
				'border-radius: 8px',
				'border: 1px solid #7f1d1d',
				'background: #450a0a',
				'color: #fecaca',
				'cursor: pointer',
				'font-size: 12px'
			].join(';');

			removeBtn.addEventListener('click', () => {
				row.remove();
			});

			row.appendChild(nameInput);
			row.appendChild(urlInput);
			row.appendChild(removeBtn);
			list.appendChild(row);
		};

		const storedItems = getWebhookItems();
		if (storedItems.length > 0) {
			storedItems.forEach((item) => addRow(item));
		} else {
			addRow({ name: 'Webhook 1', url: '' });
		}

		const buttonRow = document.createElement('div');
		buttonRow.style.cssText = 'display: flex; gap: 8px; justify-content: space-between;';

		const leftButtons = document.createElement('div');
		leftButtons.style.cssText = 'display: flex; gap: 8px;';

		const rightButtons = document.createElement('div');
		rightButtons.style.cssText = 'display: flex; gap: 8px;';

		const addBtn = document.createElement('button');
		addBtn.type = 'button';
		addBtn.textContent = '新增';
		addBtn.style.cssText = [
			'padding: 8px 12px',
			'border-radius: 8px',
			'border: 1px solid #0369a1',
			'background: #0c4a6e',
			'color: #e0f2fe',
			'cursor: pointer'
		].join(';');

		const cancelBtn = document.createElement('button');
		cancelBtn.type = 'button';
		cancelBtn.textContent = '取消';
		cancelBtn.style.cssText = [
			'padding: 8px 12px',
			'border-radius: 8px',
			'border: 1px solid #475569',
			'background: #0f172a',
			'color: #e2e8f0',
			'cursor: pointer'
		].join(';');

		const clearBtn = document.createElement('button');
		clearBtn.type = 'button';
		clearBtn.textContent = '清除全部';
		clearBtn.style.cssText = [
			'padding: 8px 12px',
			'border-radius: 8px',
			'border: 1px solid #7f1d1d',
			'background: #450a0a',
			'color: #fecaca',
			'cursor: pointer'
		].join(';');

		const saveBtn = document.createElement('button');
		saveBtn.type = 'button';
		saveBtn.textContent = '儲存';
		saveBtn.style.cssText = [
			'padding: 8px 14px',
			'border-radius: 8px',
			'border: 1px solid #0369a1',
			'background: #0284c7',
			'color: #f8fafc',
			'font-weight: 700',
			'cursor: pointer'
		].join(';');

		cancelBtn.addEventListener('click', () => {
			closeWebhookConfigModal();
		});

		clearBtn.addEventListener('click', () => {
			list.innerHTML = '';
			addRow({ name: 'Webhook 1', url: '' });
		});

		addBtn.addEventListener('click', () => {
			const nextIndex = list.children.length + 1;
			addRow({ name: `Webhook ${nextIndex}`, url: '' });
		});

		saveBtn.addEventListener('click', () => {
			const rows = Array.from(list.children);
			const items = [];

			for (let index = 0; index < rows.length; index += 1) {
				const row = rows[index];
				const inputs = row.querySelectorAll('input');
				const nameInput = inputs[0];
				const urlInput = inputs[1];
				const rawName = nameInput ? nameInput.value.trim() : '';
				const rawUrl = urlInput ? urlInput.value.trim() : '';

				if (!rawName && !rawUrl) {
					continue;
				}

				if (!rawUrl) {
					showToast(`第 ${index + 1} 行缺少 Webhook URL`, true);
					return;
				}

				const normalizedUrl = normalizeWebhookUrl(rawUrl);
				if (!normalizedUrl) {
					showToast(`第 ${index + 1} 行 Webhook 格式無效`, true);
					return;
				}

				items.push({
					name: normalizeWebhookName(rawName, `Webhook ${items.length + 1}`),
					url: normalizedUrl
				});
			}

			if (items.length === 0) {
				showToast('請至少設定 1 個 Webhook', true);
				return;
			}

			setWebhookItems(items);
			showToast(`已儲存 Webhook (${items.length} 個)`, false);
			closeWebhookConfigModal();
		});

		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) {
				closeWebhookConfigModal();
			}
		});

		overlay.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				closeWebhookConfigModal();
			}
		});

		leftButtons.appendChild(addBtn);
		leftButtons.appendChild(clearBtn);

		rightButtons.appendChild(cancelBtn);
		rightButtons.appendChild(saveBtn);

		buttonRow.appendChild(leftButtons);
		buttonRow.appendChild(rightButtons);

		panel.appendChild(title);
		panel.appendChild(subtitle);
		panel.appendChild(list);
		panel.appendChild(buttonRow);
		overlay.appendChild(panel);

		document.body.appendChild(overlay);
		const firstInput = list.querySelector('input');
		if (firstInput) {
			firstInput.focus();
		}
	}

	function registerMenuCommands() {
		GM_registerMenuCommand('開啟 Webhook 設定視窗', () => {
			openWebhookConfigModal();
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

	async function postToAllDiscordWebhooks(webhookUrls, sharedUrl) {
		const CONCURRENCY_LIMIT = 3;
		const results = [];

		for (let i = 0; i < webhookUrls.length; i += CONCURRENCY_LIMIT) {
			const batch = webhookUrls.slice(i, i + CONCURRENCY_LIMIT);
			const batchResults = await Promise.allSettled(
				batch.map((webhookUrl) => postToDiscord(webhookUrl, sharedUrl))
			);
			results.push(...batchResults);

			// Small delay between batches to avoid Discord rate limiting
			if (i + CONCURRENCY_LIMIT < webhookUrls.length) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}

		const successCount = results.filter((result) => result.status === 'fulfilled').length;
		const failedResults = results.filter((result) => result.status === 'rejected');

		return {
			total: webhookUrls.length,
			successCount,
			failedCount: failedResults.length,
			firstErrorMessage: failedResults.length > 0
				? (failedResults[0].reason && failedResults[0].reason.message) || '未知錯誤'
				: ''
		};
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
		iconContainer.innerHTML = DISCORD_ICON_SVG;

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
			const webhookItems = getWebhookItems();
			const webhookUrls = webhookItems.map((item) => item.url);
			if (webhookUrls.length === 0) {
				showToast('請先在腳本選單設定至少 1 個 Discord Webhook', true);
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
				label.textContent = `傳送中... (${webhookUrls.length})`;
			} else {
				item.textContent = `傳送中... (${webhookUrls.length})`;
			}

			try {
				const sendResult = await postToAllDiscordWebhooks(webhookUrls, fixedUrl);
				if (sendResult.failedCount === 0) {
					showToast(`傳送成功：${sendResult.successCount}/${sendResult.total}`, false);
				} else if (sendResult.successCount > 0) {
					showToast(
						`部分成功：${sendResult.successCount}/${sendResult.total}，失敗 ${sendResult.failedCount}`,
						true
					);
				} else {
					showToast(`全部失敗：${sendResult.firstErrorMessage}`, true);
				}
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

			// Reset context for each new share click to prevent stale URLs
			lastSharedPostUrl = '';

			const article = shareButton.closest('article') || findArticleInPath(path);
			const postUrl = getPostUrlFromArticle(article);
			if (postUrl) {
				lastSharedPostUrl = postUrl;
			}
		}, true);
	}

	function setupDialogObserver() {
		const observer = new MutationObserver(debounce(() => {
			const dropdowns = document.querySelectorAll(DROPDOWN_SELECTOR);
			dropdowns.forEach((dropdown) => {
				injectDiscordButton(dropdown);
			});
		}, 50));

		observer.observe(document.body, {
			childList: true,
			subtree: true
		});

		window.addEventListener('beforeunload', () => {
			observer.disconnect();
		}, { once: true });

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

//:3