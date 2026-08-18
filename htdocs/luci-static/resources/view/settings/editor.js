'use strict';
'require view';
'require fs';
'require ui';

var LIST_FILE = '/etc/luci-app-settings.json';
var CHECK_DIR = '/tmp/luci-app-settings';

var PRESET_FILES = [
	{ path: '/etc/config/network',  title: _('Network') },
	{ path: '/etc/config/dhcp',     title: _('DHCP / DNS') },
	{ path: '/etc/config/firewall', title: _('Firewall') },
	{ path: '/etc/config/system',   title: _('System') }
];

function parseCustomList(raw) {
	var list = [];

	try { list = JSON.parse(raw); }
	catch (e) { list = []; }

	if (!Array.isArray(list))
		list = [];

	return list.filter(function(item) {
		return item != null &&
		       typeof(item.path) == 'string' &&
		       item.path.charAt(0) == '/';
	});
}

function detectInitScript(path) {
	var base = path.replace(/^.*\//, '');
	var candidates = [ base ];
	var stripped = base.replace(/\.[^.]+$/, '');

	if (stripped != '' && stripped != base)
		candidates.push(stripped);

	/* e.g. /etc/sing-box/config.json -> "sing-box" */
	var parent = path.replace(/\/[^\/]+$/, '').replace(/^.*\//, '');

	if (parent != '' && parent != 'etc' && candidates.indexOf(parent) == -1)
		candidates.push(parent);

	return candidates.reduce(function(promise, cand) {
		return promise.then(function(found) {
			if (found != null)
				return found;

			return L.resolveDefault(fs.stat('/etc/init.d/' + cand), null).then(function(st) {
				return (st != null && st.type == 'file') ? cand : null;
			});
		});
	}, Promise.resolve(null));
}

/* --- CodeMirror 6 integration (bundled as settings/cm6.js, textarea fallback) --- */

function loadCM6() {
	if (window.__CM6 != null)
		return Promise.resolve(true);

	return new Promise(function(resolveFn) {
		var s = document.createElement('script');

		s.src = L.resource('settings/cm6.js') + '?v=1';
		s.onload = function() { resolveFn(window.__CM6 != null); };
		s.onerror = function() { resolveFn(false); };
		document.head.appendChild(s);
	});
}

var uciLang = null, shellLang = null;

function languageExtensions(path) {
	var C = window.__CM6;

	if (/\.json$/.test(path))
		return [ C.json(), C.lintGutter(), C.linter(C.jsonParseLinter()) ];

	if (/^\/etc\/config\//.test(path)) {
		if (uciLang == null)
			uciLang = C.StreamLanguage.define({
				startState: function() { return { n: 0 }; },
				token: function(stream, st) {
					if (stream.sol())
						st.n = 0;

					if (stream.eatSpace())
						return null;

					if (stream.match(/^#.*/))
						return 'comment';

					var idx = st.n++;

					if (stream.match(/^'([^'\\]|\\.)*'/) || stream.match(/^"([^"\\]|\\.)*"/))
						return 'string';

					if (stream.match(/^['"].*/))
						return 'invalid';

					if (stream.match(/^[^\s#'"]+/)) {
						if (idx == 0)
							return /^(config|option|list|package)$/.test(stream.current())
								? 'keyword' : 'invalid';

						return (idx == 1) ? 'variableName' : 'atom';
					}

					stream.next();
					return null;
				}
			});

		return [ uciLang, C.lintGutter() ];
	}

	if (/\.sh$/.test(path) || /^\/etc\/init\.d\//.test(path) || /^\/etc\/rc\./.test(path)) {
		if (shellLang == null)
			shellLang = C.StreamLanguage.define(C.shell);

		return [ shellLang ];
	}

	return [];
}

function createEditor(entry) {
	var C = window.__CM6;
	var dark = (window.matchMedia != null) &&
	           window.matchMedia('(prefers-color-scheme: dark)').matches;

	var exts = [
		C.lineNumbers(),
		C.highlightActiveLineGutter(),
		C.highlightSpecialChars(),
		C.history(),
		C.drawSelection(),
		C.indentOnInput(),
		C.syntaxHighlighting(C.defaultHighlightStyle, { fallback: true }),
		C.bracketMatching(),
		C.highlightActiveLine(),
		C.highlightSelectionMatches(),
		C.keymap.of([].concat(C.defaultKeymap, C.historyKeymap, C.searchKeymap,
			C.lintKeymap, [ C.indentWithTab ])),
		C.EditorView.theme({
			'&': { 'height': '34em', 'border': '1px solid #999', 'font-size': '13px' },
			'.cm-scroller': { 'font-family': 'SFMono-Regular, Consolas, Menlo, monospace', 'overflow': 'auto' }
		})
	].concat(languageExtensions(entry.path));

	if (dark)
		exts.push(C.oneDark);

	entry.cmView = new C.EditorView({
		state: C.EditorState.create({ doc: entry.content, extensions: exts })
	});

	return entry.cmView.dom;
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		var self = this;

		return loadCM6().then(function() {
			return L.resolveDefault(fs.read(LIST_FILE), '');
		}).then(function(raw) {
			self.customList = parseCustomList(raw);

			var entries = PRESET_FILES.map(function(p) {
				return {
					path: p.path,
					title: p.title,
					custom: false
				};
			}).concat(self.customList.map(function(c) {
				return {
					path: c.path,
					title: c.path.replace(/^.*\//, ''),
					service: (typeof(c.service) == 'string') ? c.service : '',
					custom: true
				};
			}));

			return Promise.all(entries.map(function(entry) {
				return Promise.all([
					L.resolveDefault(fs.stat(entry.path), null),
					L.resolveDefault(fs.read(entry.path), null),
					(entry.custom && entry.service == '')
						? detectInitScript(entry.path) : Promise.resolve(null)
				]).then(function(res) {
					entry.stat = res[0];
					entry.exists = (res[0] != null);
					entry.content = (res[1] != null) ? res[1] : '';
					entry.detected = res[2];
					return entry;
				});
			}));
		});
	},

	statLine: function(entry) {
		if (!entry.exists)
			return _('%s — file does not exist yet, it will be created when saving.').format(entry.path);

		return _('%s — %d bytes, last modified: %s').format(
			entry.path,
			entry.stat.size,
			new Date(entry.stat.mtime * 1000).toLocaleString());
	},

	getValue: function(entry) {
		return entry.cmView ? entry.cmView.state.doc.toString() : entry.textarea.value;
	},

	setValue: function(entry, value) {
		if (entry.cmView) {
			if (entry.cmView.state.doc.toString() != value)
				entry.cmView.dispatch({
					changes: { from: 0, to: entry.cmView.state.doc.length, insert: value }
				});
		}
		else {
			entry.textarea.value = value;
		}
	},

	clearDiagnostics: function(entry) {
		if (entry.cmView)
			entry.cmView.dispatch(window.__CM6.setDiagnostics(entry.cmView.state, []));
	},

	markErrorLine: function(entry, line, message) {
		if (!entry.cmView)
			return;

		var C = window.__CM6;
		var view = entry.cmView;
		var lnum = Math.max(1, Math.min(line || 1, view.state.doc.lines));
		var info = view.state.doc.line(lnum);

		view.dispatch(C.setDiagnostics(view.state, [
			{ from: info.from, to: info.to, severity: 'error', message: message }
		]));
		view.dispatch({ selection: { anchor: info.from }, scrollIntoView: true });
		view.focus();
	},

	validateJsonSyntax: function(entry, value) {
		if (!/\.json$/.test(entry.path) || value.trim() == '')
			return Promise.resolve(null);

		try {
			JSON.parse(value);
			return Promise.resolve(null);
		}
		catch (e) {
			var err = new Error(_('JSON syntax check failed: %s').format(e.message));

			if (entry.cmView) {
				var diags = window.__CM6.jsonParseLinter()(entry.cmView);

				if (diags.length > 0)
					err.line = entry.cmView.state.doc.lineAt(diags[0].from).number;
			}

			return Promise.reject(err);
		}
	},

	validateUciSyntax: function(path, value) {
		var m = path.match(/^\/etc\/config\/([^\/]+)$/);

		if (m == null)
			return Promise.resolve(null);

		var name = m[1];

		return fs.exec('/bin/mkdir', [ '-p', CHECK_DIR ]).then(function() {
			return fs.write(CHECK_DIR + '/' + name, value, 384 /* 0600 */);
		}).then(function() {
			return fs.exec('/sbin/uci', [ '-c', CHECK_DIR, 'show', name ]);
		}).then(function(res) {
			if (res.code !== 0) {
				var msg = (res.stderr || res.stdout || '').trim();
				var err = new Error(_('UCI syntax check failed: %s').format(msg));
				var lm = msg.match(/at line (\d+)/);

				err.line = lm ? +lm[1] : null;
				throw err;
			}

			return null;
		});
	},

	confirmSaveAnyway: function(err) {
		return new Promise(function(resolveFn) {
			var done = function(ok) {
				ui.hideModal();
				resolveFn(ok);
			};

			ui.showModal(_('JSON syntax error'), [
				E('p', {}, err.message),
				E('p', {}, _('The content is not valid strict JSON. If the target program accepts comments or other relaxed JSON syntax, you can still save the file as-is.')),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': function() { done(false); }
					}, [ _('Cancel') ]),
					' ',
					E('button', {
						'class': 'cbi-button cbi-button-negative important',
						'click': function() { done(true); }
					}, [ _('Save anyway') ])
				])
			]);
		});
	},

	applyEntry: function(entry) {
		var cmd, args, what;

		if (entry.custom && entry.service != '') {
			cmd  = '/etc/init.d/' + entry.service;
			args = [ 'restart' ];
			what = _('Service "%s" has been restarted.').format(entry.service);
		}
		else {
			cmd  = '/sbin/reload_config';
			args = [];
			what = _('Changed configuration files were applied via reload_config.');
		}

		return fs.exec(cmd, args).then(function(res) {
			if (res.code !== 0)
				throw new Error(_('Command failed with exit code %d: %s').format(
					res.code, (res.stderr || res.stdout || '').trim()));

			ui.addNotification(null, E('p', [
				_('Contents of %s have been saved and applied.').format(entry.path),
				' ',
				what
			]), 'info');
		}).catch(function(err) {
			ui.addNotification(null, E('p',
				_('File was saved, but applying the changes failed: %s').format(err.message)));
		});
	},

	doSave: function(entry, apply) {
		var self = this;
		var value = self.getValue(entry).replace(/\r\n/g, '\n');

		if (value.length > 0 && value.charAt(value.length - 1) != '\n')
			value += '\n';

		return self.validateJsonSyntax(entry, value).catch(function(err) {
			if (err.line != null)
				self.markErrorLine(entry, err.line, err.message);

			return self.confirmSaveAnyway(err).then(function(confirmed) {
				if (!confirmed) {
					var abort = new Error(err.message);
					abort.cancelled = true;
					throw abort;
				}
			});
		}).then(function() {
			return self.validateUciSyntax(entry.path, value);
		}).then(function() {
			return fs.write(entry.path, value, 420 /* 0644 */);
		}).then(function() {
			self.clearDiagnostics(entry);
			self.setValue(entry, value);

			return L.resolveDefault(fs.stat(entry.path), null).then(function(st) {
				entry.stat = st;
				entry.exists = (st != null);
				entry.statnode.textContent = self.statLine(entry);
			});
		}).then(function() {
			if (!apply) {
				ui.addNotification(null, E('p',
					_('Contents of %s have been saved.').format(entry.path)), 'info');
				return null;
			}

			return self.applyEntry(entry);
		}).catch(function(err) {
			if (err.cancelled) {
				ui.addNotification(null, E('p',
					_('Save cancelled: %s was not modified and no apply action was performed.').format(entry.path)), 'info');
				return;
			}

			if (err.line != null)
				self.markErrorLine(entry, err.line, err.message);

			ui.addNotification(null, E('p', [
				_('Unable to save %s: %s').format(entry.path, err.message),
				' ',
				_('The file on disk was not modified and no apply action was performed.')
			]));
		});
	},

	writeCustomList: function(list) {
		return fs.write(LIST_FILE, JSON.stringify(list, null, '\t') + '\n', 420 /* 0644 */);
	},

	handleAddSave: function(pathinput, svcinput, ev) {
		var self = this;
		var path = pathinput.value.trim();
		var svc = svcinput.value.trim();

		if (path == '' || path.charAt(0) != '/') {
			ui.addNotification(null, E('p', _('Please enter an absolute file path below /etc/.')));
			return null;
		}

		if (!/^\/etc\/[A-Za-z0-9._/-]+$/.test(path) ||
		    path.indexOf('..') != -1 ||
		    path.charAt(path.length - 1) == '/') {
			ui.addNotification(null, E('p', _('Invalid file path.')));
			return null;
		}

		var dup = PRESET_FILES.some(function(p) { return p.path == path; }) ||
		          self.customList.some(function(c) { return c.path == path; });

		if (dup) {
			ui.addNotification(null, E('p', _('This file is already in the list.')));
			return null;
		}

		if (svc != '' && !/^[A-Za-z0-9._-]+$/.test(svc)) {
			ui.addNotification(null, E('p', _('Invalid service name.')));
			return null;
		}

		var newList = self.customList.concat([ { path: path, service: svc } ]);

		return self.writeCustomList(newList).then(function() {
			ui.hideModal();
			window.location.reload();
		}).catch(function(err) {
			ui.addNotification(null, E('p',
				_('Failed to update the custom file list: %s').format(err.message)));
		});
	},

	handleAddFile: function(ev) {
		var self = this;

		var pathinput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width:100%',
			'placeholder': '/etc/sysctl.conf'
		});

		var svcinput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'style': 'width:100%',
			'placeholder': 'dnsmasq'
		});

		var matchbadge = E('span', {
			'style': 'display:none; margin-left:.5em; color:#00a000; white-space:nowrap'
		}, [ _('Matched') ]);

		var detectTimer = null;

		var runDetect = function() {
			var path = pathinput.value.trim();

			if (!/^\/etc\/[A-Za-z0-9._/-]+$/.test(path) ||
			    path.indexOf('..') != -1 ||
			    path.charAt(path.length - 1) == '/') {
				matchbadge.style.display = 'none';
				return;
			}

			detectInitScript(path).then(function(cand) {
				if (cand != null) {
					if (svcinput.value == '' || svcinput.getAttribute('data-auto') == '1') {
						svcinput.value = cand;
						svcinput.setAttribute('data-auto', '1');
					}

					matchbadge.style.display = (svcinput.value == cand) ? '' : 'none';
				}
				else {
					matchbadge.style.display = 'none';

					if (svcinput.getAttribute('data-auto') == '1') {
						svcinput.value = '';
						svcinput.removeAttribute('data-auto');
					}
				}
			});
		};

		pathinput.addEventListener('input', function() {
			if (detectTimer != null)
				window.clearTimeout(detectTimer);

			detectTimer = window.setTimeout(runDetect, 400);
		});

		svcinput.addEventListener('input', function() {
			svcinput.removeAttribute('data-auto');
			matchbadge.style.display = 'none';
		});

		ui.showModal(_('Add custom file'), [
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('File path') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					pathinput,
					E('div', { 'class': 'cbi-value-description' },
						_('Absolute path under /etc/, e.g. /etc/sysctl.conf.'))
				])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('Init script to restart on apply (optional)') ]),
				E('div', { 'class': 'cbi-value-field' }, [
					E('div', { 'style': 'display:flex; align-items:center' }, [
						svcinput,
						matchbadge
					]),
					E('div', { 'class': 'cbi-value-description' },
						_('init.d service name; leave empty to run reload_config.'))
				])
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'cbi-button cbi-button-positive important',
					'click': ui.createHandlerFn(self, 'handleAddSave', pathinput, svcinput)
				}, [ _('Add') ])
			])
		]);

		pathinput.focus();
	},

	handleResetEntry: function(entry, ev) {
		var self = this;

		return Promise.all([
			L.resolveDefault(fs.stat(entry.path), null),
			L.resolveDefault(fs.read(entry.path), null)
		]).then(function(res) {
			entry.stat = res[0];
			entry.exists = (res[0] != null);
			entry.content = (res[1] != null) ? res[1] : '';
			self.clearDiagnostics(entry);
			self.setValue(entry, entry.content);
			entry.statnode.textContent = self.statLine(entry);

			ui.addNotification(null, E('p',
				_('Contents of %s have been reloaded from disk.').format(entry.path)), 'info');
		});
	},

	handleRemoveEntry: function(entry, ev) {
		var self = this;
		var newList = self.customList.filter(function(c) { return c.path != entry.path; });

		return self.writeCustomList(newList).then(function() {
			window.location.reload();
		}).catch(function(err) {
			ui.addNotification(null, E('p',
				_('Failed to update the custom file list: %s').format(err.message)));
		});
	},

	renderPane: function(entry, idx) {
		var self = this;

		entry.statnode = E('div', { 'class': 'cbi-section-descr' });
		entry.statnode.textContent = self.statLine(entry);

		var children = [ entry.statnode ];

		if (window.__CM6 != null) {
			children.push(createEditor(entry));
		}
		else {
			entry.textarea = E('textarea', {
				'style': 'width:100%; font-family:monospace; white-space:pre;',
				'rows': 25,
				'wrap': 'off',
				'spellcheck': 'false'
			});

			entry.textarea.value = entry.content;
			children.push(entry.textarea);
		}

		if (entry.custom) {
			var applyText;

			if (entry.service != '') {
				applyText = _('Apply action: restart service "%s".').format(entry.service);
			}
			else {
				applyText = _('Apply action: run reload_config (this only reloads services for files under /etc/config).');

				if (entry.detected)
					applyText += ' ' + _('Detected init.d script with the same name: "%s".').format(entry.detected);
			}

			children.push(E('div', { 'class': 'cbi-section-descr' }, applyText));
		}

		var btns = [
			E('button', {
				'class': 'cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(self, 'doSave', entry, true)
			}, [ _('Save & Apply') ]),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-save',
				'click': ui.createHandlerFn(self, 'doSave', entry, false)
			}, [ _('Save') ]),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(self, 'handleResetEntry', entry)
			}, [ _('Reset') ])
		];

		if (entry.custom)
			btns.push(' ', E('button', {
				'class': 'cbi-button cbi-button-remove',
				'click': ui.createHandlerFn(self, 'handleRemoveEntry', entry)
			}, [ _('Remove from list') ]));

		children.push(E('div', { 'class': 'cbi-page-actions' }, btns));

		var pane = E('div', {
			'data-tab': 'file' + idx,
			'data-tab-title': entry.title
		}, children);

		pane.addEventListener('cbi-tab-active', function() {
			if (entry.cmView)
				entry.cmView.requestMeasure();
		});

		return pane;
	},

	render: function(entries) {
		var self = this;

		self.entries = entries;

		var paneContainer = E('div', {}, entries.map(function(entry, idx) {
			return self.renderPane(entry, idx);
		}));

		var node = E('div', {}, [
			E('h2', {}, [ _('Configuration Files') ]),
			E('div', { 'class': 'cbi-map-descr' },
				_('Directly edit the raw contents of common UCI configuration files under /etc/config and apply the changes. Custom files can be added to the list with the button below.')),
			E('div', { 'style': 'margin-bottom:1em' }, [
				E('button', {
					'class': 'cbi-button cbi-button-add',
					'click': ui.createHandlerFn(self, 'handleAddFile')
				}, [ _('Add custom file…') ])
			]),
			paneContainer
		]);

		ui.tabs.initTabGroup(paneContainer.childNodes);

		return node;
	}
});
