/**
 * Browser-side bridge that emulates the VS Code webview messaging API.
 *
 * The Git Graph web front-end only depends on two contracts:
 *   1. `acquireVsCodeApi()` returns `{ postMessage, getState, setState }`
 *   2. responses arrive as `window` "message" events whose `data` is the response object
 *
 * Both are provided here on top of a WebSocket connection to the local server.
 */
(function () {
	'use strict';

	var STATE_KEY = 'git-graph.webviewState';
	var queue = [];
	var socket = null;
	var connected = false;
	var reconnectDelay = 250;
	var permanentFailure = false;

	function send(message) {
		if (!permanentFailure && connected && socket !== null && socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'request', data: message }));
		} else if (!permanentFailure) {
			queue.push(message);
		}
	}

	function flush() {
		while (queue.length > 0) {
			socket.send(JSON.stringify({ type: 'request', data: queue.shift() }));
		}
	}

	function showDisconnected() {
		if (document.getElementById('gg-disconnected')) return;
		var banner = document.createElement('div');
		banner.id = 'gg-disconnected';
		banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 12px;'
			+ 'background:#be1100;color:#fff;font:13px system-ui;text-align:center';
		banner.textContent = 'Connection to Git Graph was lost. Reload this page to reconnect.';
		document.body.appendChild(banner);
	}

	function connect() {
		var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
		socket = new WebSocket(protocol + location.host + '/ws');

		socket.onopen = function () {
			connected = true;
			reconnectDelay = 250;
			flush();
		};

		socket.onmessage = function (event) {
			var message;
			try {
				message = JSON.parse(event.data);
			} catch (e) {
				return;
			}
			if (message.type === 'response') {
				window.postMessage(message.data, '*');
			} else if (message.type === 'reload') {
				window.location.reload();
			}
		};

		socket.onclose = function () {
			connected = false;
			if (permanentFailure) return;
			showDisconnected();
			setTimeout(connect, reconnectDelay);
			reconnectDelay = Math.min(reconnectDelay * 2, 5000);
		};

		socket.onerror = function () {
			try {
				socket.close();
			} catch (e) { }
		};
	}

	window.acquireVsCodeApi = function () {
		return {
			postMessage: send,
			getState: function () {
				try {
					var stored = window.localStorage.getItem(STATE_KEY);
					return stored === null ? null : JSON.parse(stored);
				} catch (e) {
					return null;
				}
			},
			setState: function (state) {
				try {
					window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
				} catch (e) { }
			}
		};
	};

	connect();
})();
