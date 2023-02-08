const { Regex } = require('@companion-module/base')

function build_templatedata_string(options) {
	let templateData = {}

	let match
	const re = /(([^=]+?)="([^"]+?)"[ ,]*)/g
	while ((match = re.exec(options.variables)) !== null) {
		templateData[esc(match[2])] = esc(match[3])
	}

	if (Object.keys(templateData).length === 0) {
		return null
	}

	if (options.json === true) {
		return JSON.stringify(templateData)
	} else {
		let templ = '<templateData>'
		for (var key in templateData) {
			templ += '<componentData id="' + key + '"><data id="text" value="' + templateData[key] + '" /></componentData>'
		}
		templ += '</templateData>'
		return templ
	}
}

function AMCP_PARAMETER(data) {
	data = data.replace(/\//g, '\\\\')
	data = data.replace(/"/g, '\\"')

	if (data.match(/\s/)) {
		return '"' + data + '"'
	}

	return data
}

function esc(str) {
	return str.replace(/"/g, '&quot;')
}

module.exports = function compileActionDefinitions(self) {
	const CHOICES_YESNO_BOOLEAN = [
		{ id: 'true', label: 'Yes' },
		{ id: 'false', label: 'No' },
	]

	const LOADPLAYPARAMS = [
		{
			label: 'Channel',
			type: 'textinput',
			id: 'channel',
			default: 1,
			regex: '/^\\d+$/',
		},
		{
			label: 'Layer',
			type: 'textinput',
			id: 'layer',
			default: '',
			regex: '/^\\d*$/',
		},
		{
			label: 'Clip',
			type: 'dropdown',
			id: 'clip_dd',
			default: '',
			choices: self.CHOICES_MEDIAFILES,
		},
		{
			label: 'Or clip name',
			type: 'textinput',
			id: 'clip',
			default: '',
		},
		{
			label: 'Loop clip',
			type: 'dropdown',
			id: 'loop',
			default: 'false',
			choices: CHOICES_YESNO_BOOLEAN,
		},
		{
			label: 'Autostart after FG clip',
			type: 'dropdown',
			id: 'auto',
			default: 'false',
			choices: CHOICES_YESNO_BOOLEAN,
		},
		{
			label: 'Transition',
			type: 'dropdown',
			id: 'transition',
			default: 'CUT',
			choices: [
				{ label: 'CUT', id: 'CUT' },
				{ label: 'MIX', id: 'MIX' },
				{ label: 'PUSH', id: 'PUSH' },
				{ label: 'WIPE', id: 'CUT' },
				{ label: 'SLIDE', id: 'SLIDE' },
			],
		},
		{
			label: 'Transition duration',
			type: 'textinput',
			id: 'transition_duration',
			default: '',
			regex: Regex.NUMBER,
		},
		{
			label: 'Transition tween',
			type: 'textinput',
			id: 'transition_tween',
			default: 'linear',
		},
	]

	const PAUSERESUMESTOPCLEARPARAMS = [
		{
			label: 'Channel',
			type: 'textinput',
			id: 'channel',
			default: 1,
			regex: '/^\\d+$/',
		},
		{
			label: 'Layer',
			type: 'textinput',
			id: 'layer',
			default: '',
			regex: '/^\\d*$/',
		},
	]

	const sendCommand = (cmd) => {
		if (cmd) {
			self.log('debug', 'sending tcp ' + cmd + ' to ' + self.config.host)

			if (self.socket && self.socket.isConnected) {
				self.socket.send(cmd + '\r\n')
			} else {
				self.log('debug', 'Socket not connected :(')
			}
		}
	}
	const sendLoadPlay = (cmd, action) => {
		let out = cmd + ' ' + parseInt(action.options.channel)

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer)
		}

		if (action.options.clip) {
			out += ' ' + AMCP_PARAMETER(action.options.clip)
		} else if (action.options.clip_dd) {
			out += ' ' + AMCP_PARAMETER(action.options.clip_dd)
		}

		if (action.options.loop == 'true') {
			out += ' LOOP'
		}

		if (action.options.transition != 'CUT') {
			out += ' ' + action.options.transition
			out += ' ' + parseFloat(action.options.transition_duration)
			out += ' ' + AMCP_PARAMETER(action.options.transition_tween)
		}

		if (action.options.auto == 'true') {
			out += ' AUTO'
		}

		sendCommand(out)
	}
	const sendPauseResumeStopClear = (cmd, action) => {
		let out = cmd + ' ' + parseInt(action.options.channel)

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer)
		}

		sendCommand(out)
	}

	return {
		LOADBG: {
			name: 'LOADBG',
			options: LOADPLAYPARAMS,
			callback: (action) => {
				sendLoadPlay('LOADBG', action)
			},
		},
		LOAD: {
			name: 'LOAD',
			options: LOADPLAYPARAMS,
			callback: (action) => {
				sendLoadPlay('LOAD', action)
			},
		},
		PLAY: {
			name: 'PLAY',
			options: LOADPLAYPARAMS,
			callback: (action) => {
				sendLoadPlay('PLAY', action)
			},
		},
		PAUSE: {
			name: 'PAUSE',
			options: PAUSERESUMESTOPCLEARPARAMS,
			callback: (action) => {
				sendPauseResumeStopClear('PAUSE', action)
			},
		},
		RESUME: {
			label: 'RESUME',
			options: PAUSERESUMESTOPCLEARPARAMS,
			callback: (action) => {
				sendPauseResumeStopClear('RESUME', action)
			},
		},
		STOP: {
			name: 'STOP',
			options: PAUSERESUMESTOPCLEARPARAMS,
			callback: (action) => {
				sendPauseResumeStopClear('STOP', action)
			},
		},
		CLEAR: {
			name: 'CLEAR',
			options: PAUSERESUMESTOPCLEARPARAMS,
			callback: (action) => {
				sendPauseResumeStopClear('CLEAR', action)
			},
		},
		CALL: {
			name: 'CALL',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/',
				},
				{
					label: 'Method',
					type: 'textinput',
					id: 'method',
					regex: '/^.+$/',
				},
			],
			callback: (action) => {
				let cmd = 'CALL ' + parseInt(action.options.channel)

				if (action.options.layer != '') {
					cmd += '-' + parseInt(action.options.layer)
				}

				// This should not be ACMP_PARAMETER-sanetized, since it is actual commands/parameters
				cmd += ' ' + action.options.method

				sendCommand(cmd)
			},
		},
		SWAP: {
			name: 'SWAP',
			options: [
				{
					label: 'Channel 1',
					type: 'textinput',
					id: 'channel1',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer 1',
					type: 'textinput',
					id: 'layer1',
					default: '',
					regex: '/^\\d*$/',
				},
				{
					label: 'Channel 2',
					type: 'textinput',
					id: 'channel2',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer 2',
					type: 'textinput',
					id: 'layer2',
					default: '',
					regex: '/^\\d*$/',
				},
				{
					label: 'Swap transforms',
					type: 'dropdown',
					id: 'transforms',
					choices: CHOICES_YESNO_BOOLEAN,
					default: 'false',
				},
			],
			callback: (action) => {
				let cmd = +'SWAP ' + parseInt(action.options.channel1)

				if (action.options.layer != '') {
					cmd += '-' + parseInt(action.options.layer1)
				}

				cmd += ' ' + parseInt(action.options.channel2)

				if (action.options.layer != '') {
					cmd += '-' + parseInt(action.options.layer2)
				}

				if (action.options.transforms == 'true') {
					cmd += ' TRANSFORMS'
				}

				sendCommand(cmd)
			},
		},
		'CG ADD': {
			name: 'CG ADD',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/',
				},
				{
					label: 'Template',
					type: 'dropdown',
					id: 'template_dd',
					default: '',
					choices: self.CHOICES_TEMPLATES,
				},
				{
					label: 'Or template name',
					type: 'textinput',
					id: 'template',
					default: '',
				},
				{
					label: 'Play on load',
					type: 'dropdown',
					id: 'playonload',
					choices: CHOICES_YESNO_BOOLEAN,
					default: 'false',
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: Regex.NUMBER,
				},
				{
					label: 'Send as JSON',
					type: 'checkbox',
					id: 'json',
					default: false,
				},
				{
					label: 'Template variables',
					type: 'textinput',
					id: 'variables',
					tooltip: 'Example: f0="John Doe" f1="Foobar janitor"',
					default: 'f0="John Doe"',
					regex: '/(^([^=]+="[^"]+"[ ,]*)+$|^$)/',
				},
			],
			callback: async (action) => {
				let cmd = 'CG ' + parseInt(action.options.channel)

				if (action.options.layer != '') {
					cmd += '-' + parseInt(action.options.layer)
				}

				cmd += ' ADD'

				if (action.options.templatelayer != '') {
					cmd += ' ' + parseInt(action.options.templatelayer)
				}

				if (action.options.template) {
					cmd += ' ' + AMCP_PARAMETER(action.options.template)
				} else if (action.options.template_dd) {
					cmd += ' ' + AMCP_PARAMETER(action.options.template_dd)
				}

				if (action.options.playonload == 'true' || action.options.variables != '') {
					cmd += ' ' + (action.options.playonload == 'true' ? '1' : '0')
				}

				if (action.options.variables != '') {
					const templ = build_templatedata_string(action.options)
					if (templ) {
						const value = await self.parseVariablesInString(templ)
						cmd += ' "' + value.replace(/"/g, '\\"') + '"'
					}
				}

				sendCommand(cmd)
			},
		},
		'CG UPDATE': {
			name: 'CG UPDATE',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/',
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: '/^\\d+$/',
				},
				{
					label: 'Send as JSON',
					type: 'checkbox',
					id: 'json',
					default: false,
				},
				{
					label: 'Template variables',
					type: 'textinput',
					id: 'variables',
					tooltip: 'Example: f0="John Doe" f1="Foobar janitor"',
					default: '',
					regex: '/(^([^=]+="[^"]+"[ ,]*)+$|^$)/',
				},
			],
			callback: async (action) => {
				let cmd = 'CG ' + parseInt(action.options.channel)

				if (action.options.layer != '') {
					cmd += '-' + parseInt(action.options.layer)
				}

				cmd += ' UPDATE'

				cmd += ' ' + parseInt(action.options.templatelayer)

				if (action.options.variables != '') {
					var templ = build_templatedata_string(action.options)
					if (templ) {
						const value = await self.parseVariablesInString(templ)
						cmd += ' "' + value.replace(/"/g, '\\"') + '"'
					}
				}

				sendCommand(cmd)
			},
		},
		'CG PLAY': {
			name: 'CG PLAY',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/',
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: Regex.NUMBER,
				},
			],
			callback: (action) => {
				let cmd = 'CG ' + parseInt(action.options.channel)

				if (action.options.layer != '') {
					cmd += '-' + parseInt(action.options.layer)
				}

				cmd += ' PLAY'

				cmd += ' ' + parseInt(action.options.templatelayer)

				sendCommand(cmd)
			},
		},
		'CG STOP': {
			name: 'CG STOP',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/',
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: Regex.NUMBER,
				},
			],
			callback: (action) => {
				let cmd = 'CG ' + parseInt(action.options.channel)

				if (action.options.layer != '') {
					cmd += '-' + parseInt(action.options.layer)
				}

				cmd += ' STOP'

				cmd += ' ' + parseInt(action.options.templatelayer)

				sendCommand(cmd)
			},
		},
		COMMAND: {
			name: 'Manually specify AMCP command',
			options: [
				{
					type: 'textinput',
					label: 'Command',
					id: 'cmd',
					default: 'CLEAR 1',
				},
			],
			callback: (action) => {
				sendCommand(action.options.cmd)
			},
		},
		GOTO: {
			name: 'Goto to file position (in seconds)',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/',
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d+$/',
				},
				{
					type: 'textinput',
					label: 'Seconds (from end: prefix "-")',
					id: 'offset',
					default: '',
					regex: '/^[+-]?\\d+$/',
				},
			],
			callback: (action) => {
				let params = parseInt(action.options.channel)
				if (action.options.layer != '') {
					params += '-' + parseInt(action.options.layer)
				}

				self.requestData('INFO', params, (data) => self.executeGOTO(data, action.options))
			},
		},
	}
}
