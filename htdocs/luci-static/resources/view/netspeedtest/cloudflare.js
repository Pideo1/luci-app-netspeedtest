'use strict';
'require view';
'require poll';
'require dom';
'require fs';
'require rpc';
'require uci';
'require ui';
'require form';

const TestTimeout = 600 * 1000; // 10 Minutes
const ResultFile = '/tmp/cloudflare_speedtest_result';
const ResultJsonFile = '/tmp/cloudflare_speedtest_result.json';

const gradeMap = {
	'A': _('Good'),
	'B': _('Fairly good'),
	'C': _('Average'),
	'D': _('Rather bad'),
	'F': _('Very bad')
};

var callCloudflareDownload = rpc.declare({
	object: 'luci.netspeedtest',
	method: 'download_cloudflare',
	params: ['arch', 'tag'],
	expect: { '': {} }
});

var callCloudflareVerify = rpc.declare({
	object: 'luci.netspeedtest',
	method: 'cloudflare_verify',
	expect: { '': {} }
});

var callCloudflareSpeedtest = rpc.declare({
	object: 'luci.netspeedtest',
	method: 'cloudflare_speedtest',
	expect: { '': {} }
});

function fmtMbps(v) {
	return (Math.round(v * 100) / 100).toFixed(2);
}

function renderTextResult(json) {
	const meta = json.meta || {};
	const idle = json.idle_latency || {};
	const udp = (json.experimental_udp || {}).latency || {};
	const grade = ((json.connection_quality || {}).stability_grade || '-').toUpperCase();

	return E('div', { 'class': 'cbi-section', 'style': 'line-height:1.8;max-width:600px' }, [
		E('div', {}, _('Avg download: %s Mbps').format(fmtMbps((json.download || {}).mean_mbps || 0))),
		E('div', {}, _('Avg upload: %s Mbps').format(fmtMbps((json.upload || {}).mean_mbps || 0))),
		E('div', {}, _('Idle latency: %s ms').format(fmtMbps(idle.mean_ms || 0))),
		E('div', {}, _('Jitter: %s ms').format(idle.jitter_ms != null ? idle.jitter_ms.toFixed(2) : '-')),
		E('div', { 'style': 'margin-top:.5em' }, _('ASN organization: %s').format(json.as_org || '-')),
		E('div', {}, _('ASN: AS%s').format(json.asn || '-')),
		E('div', {}, _('City: %s').format(meta.city || '-')),
		E('div', {}, _('IP address: %s').format(json.ip || '-')),
		E('div', { 'style': 'margin-top:.5em' }, _('Region: %s').format(meta.country || '-')),
		E('div', {}, _('STUN UDP packet loss: %s%%').format(udp.loss != null ? udp.loss : '-')),
		E('div', {}, _('Network quality: %s (%s)').format(grade, gradeMap[grade] || '-'))
	]);
}

function renderImageResult(json) {
	const idle = json.idle_latency || {};
	const card = {
		downSpeed: (json.download || {}).bytes || 0,
		upSpeed: (json.upload || {}).bytes || 0,
		latency: idle.mean_ms != null ? Math.round(idle.mean_ms) : 0,
		jitter: idle.jitter_ms != null ? parseFloat(idle.jitter_ms.toFixed(2)) : 0
	};
	const b64 = btoa(JSON.stringify(card));
	const img = 'https://speed.cloudflare.com/__preview_card?results=' + b64;

	return E('div', { 'style': 'max-width:500px' }, [
		E('a', { 'href': 'https://speed.cloudflare.com', 'target': '_blank' }, [
			E('img', { 'src': img, 'style': 'max-width:100%;max-height:100%;vertical-align:middle' }, [])
		])
	]);
}

function renderJsonResult(json, text_mode) {
	if (text_mode)
		return renderTextResult(json);
	return renderImageResult(json);
}

function isBusy(content) {
	return content != 'Done' && content != 'Test failed';
}

return view.extend({
//	handleSaveApply: null,
//	handleSave: null,
//	handleReset: null,

	load() {
		return Promise.all([
			callCloudflareVerify(),
			L.resolveDefault(fs.read(ResultFile), null),
			L.resolveDefault(fs.stat(ResultFile), {}),
			uci.load('netspeedtest')
		]);
	},

	render(data) {
		const has_cf = data[0].result;
		const result_content = data[1] ? data[1].trim() : '';
		const result_mtime = data[2] ? data[2].mtime * 1000 : 0;
		const text_mode = uci.get('netspeedtest', 'config', 'cf_display_text') != '0';

		let m, s, o;

		m = new form.Map('netspeedtest', _('Cloudflare SpeedTest'));

		s = m.section(form.TypedSection, '_result');
		s.anonymous = true;
		let last_content = result_content;
		if (isBusy(last_content))
			last_content = null;
		s.render = function(section_id) {
			const El = E('div', { 'id': 'cloudflare_result' }, []);
			const Testing = E('span', { 'class': 'spinning', 'style': 'color:yellow;font-weight:bold' }, [
				_('Testing in progress...')
			]);
			const TestF = E('span', { 'style': 'color:red;font-weight:bold' }, [ _('Test failed.') ]);
			const TestN = E('span', { 'style': 'color:red;font-weight:bold' }, [ _('No result.') ]);

			const showResult = function(container, content) {
				if (content.length) {
					if (isBusy(content)) {
						const lines = content.split("\n");
						const tail = lines.slice(-15).join("\n");
						container.appendChild(Testing);
						if (content != 'Testing')
							container.appendChild(E('pre', { 'style': 'white-space:pre-wrap;font-size:12px;max-height:200px;overflow-y:auto' }, [ tail ]));
					} else if (content == 'Test failed') {
						container.appendChild(TestF);
					} else if (content == 'Done') {
						fs.read(ResultJsonFile).then(L.bind(function(res) {
							try {
								dom.content(container, [ renderJsonResult(JSON.parse(res), this.text_mode) ]);
							} catch(e) {
								dom.content(container, [ TestF ]);
							}
						}, { text_mode: uci.get('netspeedtest', 'config', 'cf_display_text') != '0' }));
					}
				} else
					container.appendChild(TestN);
			}

			poll.add(function() {
				return L.resolveDefault(fs.read(ResultFile), null).then((res) => {
					const content = res ? res.trim() : '';
					const stat = document.querySelector('#cloudflare_result');

					if (!stat || (content === last_content && !isBusy(content)))
						return;
					last_content = content;
					dom.content(stat, []);
					showResult(stat, content);
				});
			});

			showResult(El, result_content);

			return El;
		}

		s = m.section(form.NamedSection, 'config', 'netspeedtest');
		s.anonymous = true;

		o = s.option(form.Button, '_start', _('Start Test'));
		o.inputtitle = _('Start Test');
		o.inputstyle = 'apply';
		if (result_content.length && isBusy(result_content) && (Date.now() - result_mtime) < TestTimeout)
			o.readonly = true;
		o.onclick = function(ev, section_id) {
			window.setTimeout(function() {
				window.location = window.location.href.split('#')[0];
			}, L.env.apply_display * 500);

			return callCloudflareSpeedtest().then((res) => {
				if (!res.result)
					ui.addNotification(null, E('p', _('Test failed: %s').format(res.error)), 'error');
			});
		};

		o = s.option(form.DummyValue, '_cf_status', _('Cloudflare SpeedTest CLI Status'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			return E('span', {
				id: 'cf_status',
				style: `color:${has_cf ? 'green' : 'red'};font-weight:bold`
			}, [ has_cf ? _('Installed') : _('Not Installed') ]);
		};
		poll.add(function() {
			return callCloudflareVerify().then((res) => {
				const has_cf = res.result;
				const cf_stat = document.querySelector('#cf_status');

				if (cf_stat) {
					cf_stat.style.color = has_cf ? 'green' : 'red';
					dom.content(cf_stat, [ has_cf ? _('Installed') : _('Not Installed') ]);
				}
			});
		})

		o = s.option(form.Flag, 'cf_display_text', _('Detailed text result'));
		o.rmempty = false;
		o.enabled = '1';
		o.disabled = '0';
		o.default = '1';
		o.description = _('Enabled: text result with details; Disabled: image result with speed and latency only');

		o = s.option(form.Flag, 'cf_proxy_enabled', _('Enable proxy for downloader and test'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'cf_proxy_protocol', _('Proxy Protocol'));
		o.value('http', 'HTTP');
		o.value('https', 'HTTPS');
		o.value('socks5', 'SOCKS5');
		o.default = 'socks5';
		o.rmempty = false;
		o.retain = true;
		o.depends('cf_proxy_enabled', '1');

		o = s.option(form.Value, 'cf_proxy_server', _('Proxy Server'));
		o.placeholder = '[username[:password]@]address:port';
		o.rmempty = false;
		o.retain = true;
		o.depends('cf_proxy_enabled', '1');

		o = s.option(form.ListValue, '_arch', _('System Arch'));
		o.value('x86_64', 'x86_64');
		o.value('aarch64', 'aarch64 / arm64');
		o.default = 'x86_64';
		o.write = function() {};

		o = s.option(form.Value, '_tag', _('Release tag (optional)'));
		o.placeholder = 'e.g. v1.0.9 (leave empty for latest release)';
		o.write = function() {};

		o = s.option(form.Button, '_download', _('Download Cloudflare SpeedTest CLI'));
		o.inputtitle = _('Download');
		o.inputstyle = 'apply';
		o.onclick = function(ev, section_id) {
			const arch = this.section.getOption('_arch').formvalue(section_id);
			const tag = (this.section.getOption('_tag').formvalue(section_id) || '').trim();
			//console.log(arch);
			return callCloudflareDownload(arch, tag).then((res) => {
					if (res.result === true)
						ui.addNotification(null, E('p', _('Successfully download.')));
					else
						ui.addNotification(null, E('p', _('Download failed: %s').format(res.error)), 'error');
				});
		}

		return m.render();
	}
});
