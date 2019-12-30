var tcp = require('../../tcp');
var instance_skel = require('../../instance_skel');
var parseString = require('xml2js').parseString
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	self.response_callback = {};
	self.response_current = '';

	self.CHOICES_TEMPLATES = [];
	self.CHOICES_MEDIAFILES = [];

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}

function swap_obj(obj){
	var ret = {};

	for(var key in obj){
		ret[obj[key]] = key;
	}

	return ret;
}

function build_templatedata_string(options) {
	var templateData = {};

	var match;
	var re = /(([^=]+?)="([^"]+?)"[ ,]*)/g;
	while ((match = re.exec(options.variables)) !== null) {
		templateData[esc(match[2])] = esc(match[3]);
	}

	if (Object.keys(templateData).length === 0) {
		return null;
	}

	var templ = '';
	if (options.json === true) {
		templ = JSON.stringify(templateData);
	} else {
		templ += '<templateData>';
		for (var key in templateData) {
			templ += '<componentData id="' + key + '"><data id="text" value="' + templateData[key] + '" /></componentData>';
		}
		templ += '</templateData>';
	}

	return templ;
}

instance.prototype.updateConfig = function(config) {
	var self = this;

	self.config = config;
	self.init_tcp();
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.init_tcp();
};

instance.prototype.init_tcp = function() {
	var self = this;
	var receivebuffer = '';

	var ACMP_STATE = {
		NEXT: 0,
		SINGLE_LINE: 1,
		MULTI_LINE: 2
	};

	var RETCODE = {
		INFO: 100,
		INFODATA: 101,

		OKMULTIDATA: 200,
		OKDATA: 201,
		OK: 202,

		COMMAND_UNKNOWN_DATA: 400,
		INVALID_CHANNEL: 401,
		PARAMETER_MISSING: 402,
		PARAMETER_ILLEGAL: 403,
		MEDIAFILE_NOT_FOUND: 404,

		INTERNAL_SERVER_ERROR_DATA: 500,
		INTERNAL_SERVER_ERROR: 501,
		MEDIAFILE_UNREADABLE: 502,
		ACCESS_ERROR: 503
	};
	var RETCODE2TYPE = swap_obj(RETCODE);

	self.acmp_state = ACMP_STATE.NEXT;


	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	if (self.config.host) {
		self.socket = new tcp(self.config.host, self.config.port || 5250);

		self.socket.on('status_change', function (status, message) {
			self.status(status, message);
		});

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.log('error',"Network error: " + err.message);
		});

		self.socket.on('connect', function () {
			debug("Connected");

			self.requestData("CLS", null, self.handleCLS.bind(self));
			self.requestData("TLS", null, self.handleTLS.bind(self));
		});

		var receivebuffer = '';

		// separate buffered stream into lines with responses
		self.socket.on('data', function (chunk) {
			var i = 0, line = '', offset = 0;
			receivebuffer += chunk;

			while ( (i = receivebuffer.indexOf('\r\n', offset)) !== -1) {
				line = receivebuffer.substr(offset, i - offset);
				offset = i + 2;
				self.socket.emit('receiveline', line.toString());
			}

			receivebuffer = receivebuffer.substr(offset);
		});

		self.socket.on('receiveline', function (line) {
			var error = false;

			// New message
			if (self.acmp_state == ACMP_STATE.NEXT) {
				var code = line.match(/^(\d+)\s+(\S*)/);
				var status;
				if (code && code.length > 1) {
					if (code.length > 2) {
						status = code[2];
					}

					code = parseInt(code[1]);
				} else {
					self.log('error', 'Protocol out of sync, expected number: ' + line);
					return;
				}

				switch (code) {
					case RETCODE.INVALID_CHANNEL:
					case RETCODE.PARAMETER_MISSING:
					case RETCODE.PARAMETER_ILLEGAL:
					case RETCODE.MEDIAFILE_NOT_FOUND:
					case RETCODE.INTERNAL_SERVER_ERROR:
					case RETCODE.MEDIAFILE_UNREADABLE:
					case RETCODE.ACCESS_ERROR:
						error = true;
						self.error_code = code;
						// Explicit for readability
						self.acmp_state = ACMP_STATE.NEXT;
						break;

					case RETCODE.INFO:
					case RETCODE.OK:
						// Explicit for readability
						self.acmp_state = ACMP_STATE.NEXT;
						self.error_code = undefined;
						break;

					case RETCODE.COMMAND_UNKNOWN_DATA:
					case RETCODE.INTERNAL_SERVER_ERROR_DATA:
						error = true;
						self.error_code = code;
						self.acmp_state = ACMP_STATE.SINGLE_LINE;
						break;

					case RETCODE.INFODATA:
					case RETCODE.OKDATA:
						self.acmp_state = ACMP_STATE.SINGLE_LINE;
						self.response_current = status;
						self.error_code = undefined;
						break;

					case RETCODE.OKMULTIDATA:
						self.acmp_state = ACMP_STATE.MULTI_LINE;
						self.response_current = status;
						self.error_code = undefined;
						self.multilinedata = [];
						break;

					default:
						self.log('error', 'Unrecognized data from server: ' + line);
						return;
				}

				if (error && self.acmp_state == ACMP_STATE.NEXT) {
					self.log('error', 'Got error ' + RETCODE2TYPE[code] + ': ' + line);
				}
			}

			// Current line is a single-line response to last message
			else if (self.acmp_state == ACMP_STATE.SINGLE_LINE) {
				self.acmp_state = ACMP_STATE.NEXT;

				if (self.error_code !== undefined) {
					self.log('error', 'Got error ' + RETCODE2TYPE[self.error_code] + ': ' + line);
				} else {
					self.response_current = self.response_current.toUpperCase();

					if (self.response_callback[self.response_current] !== undefined && self.response_callback[self.response_current].length) {
						var cb = self.response_callback[self.response_current].shift();

						if (typeof cb == 'function') {
							cb(line);
							self.response_current = '';
						}
					}
				}
			}

			// Current line is part of a multi-line response
			else if (self.acmp_state == ACMP_STATE.MULTI_LINE) {

				if (line == '') {
					self.acmp_state = ACMP_STATE.NEXT;

					self.response_current = self.response_current.toUpperCase();

					if (self.response_callback[self.response_current] !== undefined && self.response_callback[self.response_current].length) {
						var cb = self.response_callback[self.response_current].shift();

						if (typeof cb == 'function') {
							cb(self.multilinedata);
							self.multilinedata.length = 0;
							self.response_current = '';
						}
					}
				} else {
					self.multilinedata.push(line);
				}
			}
		});

	}
};

instance.prototype.handleCLS = function(data) {
	var self = this;

	self.CHOICES_MEDIAFILES.length = 0;

	for (var i = 0; i < data.length; ++i) {
		var match = data[i].match(/^"([^"]+)"/);
		if (match && match.length > 1) {
			var file = match[1].replace(/\\/g, '\\\\');
			self.CHOICES_MEDIAFILES.push({ label: file, id: file });
		}
	}

	self.actions();
};

instance.prototype.handleTLS = function(data) {
	var self = this;

	self.CHOICES_TEMPLATES.length = 0;

	for (var i = 0; i < data.length; ++i) {
		// Template response parsing from SuperFlyTv/casparcg-connection
		// https://github.com/SuperFlyTV/casparcg-connection/blob/master/src/lib/ResponseParsers.ts#L320
		var match = data[i].match(/\"(.*?)\" +(.*)/);
		var file = null;
		if (match === null) {
			// propably 2.2.0
			file = data[i];
		} else {
			// is 2.0.7 or 2.1.0 template
			file = match[1];
		}

		if (file !== null) {
			file = file.replace(/\\/g, '\\\\');
			self.CHOICES_TEMPLATES.push({ label: file, id: file });
		}
	}

	self.actions();
};

instance.prototype.executeGOTO = function(data, options) {
	var self = this;

	if (!data || !data.length || !options) {
		return;
	}

	parseString(data, (err, result) => {
		if (err) {
			debug('Error in INFO response: ' + err)
		} else {
			try {
				var offset = parseInt(options.offset);

				var framerate = 0;
				var seek = 0;
				if (result.layer) {
					// CasparCG 2.0.7 or 2.1.0
					framerate = parseInt(result.layer.foreground[0].producer[0].fps[0]);

					if (offset >= 0) {
						seek = offset * framerate;
					} else {
						var clipFrames = parseInt(result.layer.foreground[0].producer[0]['nb-frames'][0]);
						seek = Math.floor(clipFrames + (offset * framerate));
					}
				} else if (result.channel) {
					// CasparCG 2.2.0
					framerate = parseInt(result.channel.framerate[0]);

					if (offset >= 0) {
						seek = offset * framerate;
					} else {
						var clipLength = parseFloat(result.channel.stage[0].layer[0]['layer_' + options.layer][0].foreground[0].file[0].clip[1]);
						seek = Math.floor(clipLength + offset) * framerate;
					}
				}

				if (framerate > 0) {
					var out = 'CALL ' + parseInt(options.channel);
					if (options.layer != '') {
						out += '-' + parseInt(options.layer);
					}
					out += ' SEEK ' + seek;

					if (self.socket !== undefined && self.socket.connected) {
						self.socket.send(out + "\r\n");
					}
				}
			} catch (e) {
				debug('Error in INFO response: ' + e)
			}
		}
	});
}

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;

	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'IP-Adress of CasparCG Server',
			width: 6,
			default: '',
			regex: self.REGEX_IP
		}, {
			type: 'textinput',
			id: 'port',
			label: 'AMCP TCP Port',
			default: '5250',
			regex: self.REGEX_PORT
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	debug("destroy", self.id);
};

instance.prototype.CHOICES_TRANSITIONS = [
	{ label: 'CUT',   id: 'CUT'   },
	{ label: 'MIX',   id: 'MIX'   },
	{ label: 'PUSH',  id: 'PUSH'  },
	{ label: 'WIPE',  id: 'CUT'   },
	{ label: 'SLIDE', id: 'SLIDE' }
];

instance.prototype.actions = function() {
	var self = this;

	var LOADPLAYPARAMS = [
		{
			label: 'Channel',
			type: 'textinput',
			id: 'channel',
			default: 1,
			regex: '/^\\d+$/'
		},
		{
			label: 'Layer',
			type: 'textinput',
			id: 'layer',
			default: '',
			regex: '/^\\d*$/'
		},
		{
			label: 'Clip',
			type: 'dropdown',
			id: 'clip_dd',
			default: '',
			choices: self.CHOICES_MEDIAFILES
		},
		{
			label: 'Or clip name',
			type: 'textinput',
			id: 'clip',
			default: ''
		},
		{
			label: 'Loop clip',
			type: 'dropdown',
			id: 'loop',
			default: 'false',
			choices: self.CHOICES_YESNO_BOOLEAN
		},
		{
			label: 'Autostart after FG clip',
			type: 'dropdown',
			id: 'auto',
			default: 'false',
			choices: self.CHOICES_YESNO_BOOLEAN
		},
		{
			label: 'Transition',
			type: 'dropdown',
			id: 'transition',
			default: 'CUT',
			choices: self.CHOICES_TRANSITIONS
		},
		{
			label: 'Transition duration',
			type: 'textinput',
			id: 'transition_duration',
			default: '',
			regex: self.REGEX_NUMBER
		},
		{
			label: 'Transition tween',
			type: 'textinput',
			id: 'transition_tween',
			default: 'linear'
		}
	];

	var PAUSERESUMESTOPCLEARPARAMS = [
		{
			label: 'Channel',
			type: 'textinput',
			id: 'channel',
			default: 1,
			regex: '/^\\d+$/'
		},
		{
			label: 'Layer',
			type: 'textinput',
			id: 'layer',
			default: '',
			regex: '/^\\d*$/'
		}
	];

	self.system.emit('instance_actions', self.id, {
		'LOADBG': {
			label: 'LOADBG',
			options: LOADPLAYPARAMS
		},
		'LOAD': {
			label: 'LOAD',
			options: LOADPLAYPARAMS
		},
		'PLAY': {
			label: 'PLAY',
			options: LOADPLAYPARAMS
		},
		'PAUSE': {
			label: 'PAUSE',
			options: PAUSERESUMESTOPCLEARPARAMS
		},
		'RESUME': {
			label: 'RESUME',
			options: PAUSERESUMESTOPCLEARPARAMS
		},
		'STOP': {
			label: 'STOP',
			options: PAUSERESUMESTOPCLEARPARAMS
		},
		'CLEAR': {
			label: 'CLEAR',
			options: PAUSERESUMESTOPCLEARPARAMS
		},
		'CALL': {
			label: 'CALL',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/'
				},
				{
					label: 'Method',
					type: 'textinput',
					id: 'method',
					regex: '/^.+$/'
				}
			]
		},
		'SWAP': {
			label: 'SWAP',
			options: [
				{
					label: 'Channel 1',
					type: 'textinput',
					id: 'channel1',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer 1',
					type: 'textinput',
					id: 'layer1',
					default: '',
					regex: '/^\\d*$/'
				},
				{
					label: 'Channel 2',
					type: 'textinput',
					id: 'channel2',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer 2',
					type: 'textinput',
					id: 'layer2',
					default: '',
					regex: '/^\\d*$/'
				},
				{
					label: 'Swap transforms',
					type: 'dropdown',
					id: 'transforms',
					choices: self.CHOICES_YESNO_BOOLEAN,
					default: 'false'
				}
			]
		},
		'CG ADD': {
			label: 'CG ADD',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/'
				},
				{
					label: 'Template',
					type: 'dropdown',
					id: 'template_dd',
					default: '',
					choices: self.CHOICES_TEMPLATES
				},
				{
					label: 'Or template name',
					type: 'textinput',
					id: 'template',
					default: ''
				},
				{
					label: 'Play on load',
					type: 'dropdown',
					id: 'playonload',
					choices: self.CHOICES_YESNO_BOOLEAN,
					default: 'false'
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: self.REGEX_NUMBER
				},
				{
					label: 'Send as JSON',
					type: 'checkbox',
					id: 'json',
					default: false
				},
				{
					label: 'Template variables',
					type: 'textinput',
					id: 'variables',
					tooltip: 'Example: f0="John Doe" f1="Foobar janitor"',
					default: 'f0="John Doe"',
					regex: '/(^([^=]+="[^"]+"[ ,]*)+$|^$)/'
				}
			]
		},
		'CG UPDATE': {
			label: 'CG UPDATE',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/'
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: '/^\\d+$/'
				},
				{
					label: 'Send as JSON',
					type: 'checkbox',
					id: 'json',
					default: false
				},
				{
					label: 'Template variables',
					type: 'textinput',
					id: 'variables',
					tooltip: 'Example: f0="John Doe" f1="Foobar janitor"',
					default: '',
					regex: '/(^([^=]+="[^"]+"[ ,]*)+$|^$)/'
				}
			]
		},
		'CG PLAY': {
			label: 'CG PLAY',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/'
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: self.REGEX_NUMBER
				}
			]
		},
		'CG STOP': {
			label: 'CG STOP',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d*$/'
				},
				{
					label: 'Template host layer',
					type: 'textinput',
					id: 'templatelayer',
					default: '1',
					regex: self.REGEX_NUMBER
				}
			]
		},
		'COMMAND': {
			label: 'Manually specify AMCP command',
			options: [{
				type: 'textinput',
				label: 'Command',
				id: 'cmd',
				default: 'CLEAR 1'
			}]
		},
		'GOTO': {
			label: 'Goto to file position (in seconds)',
			options: [
				{
					label: 'Channel',
					type: 'textinput',
					id: 'channel',
					default: 1,
					regex: '/^\\d+$/'
				},
				{
					label: 'Layer',
					type: 'textinput',
					id: 'layer',
					default: '',
					regex: '/^\\d+$/'
				},
				{
					type: 'textinput',
					label: 'Seconds (from end: prefix "-")',
					id: 'offset',
					default: '',
					regex: '/^[+-]?\\d+$/'
				}
			]
		}
	});
}

function AMCP_PARAMETER(data) {

	data = data.replace(/\//g, '\\\\');
	data = data.replace(/"/g, '\\"');

	if(data.match(/\s/)) {
		return '"' + data + '"';
	}

	return data;
}

function esc(str) {
	return str.replace(/"/g, "&quot;");
}

instance.prototype.requestData = function(command, params, callback) {
	var self = this;
	var out;

	if (self.socket !== undefined && self.socket.connected) {
		command = command.toUpperCase();

		if (self.response_callback[command] === undefined) {
			self.response_callback[command] = [];
		}

		self.response_callback[command].push(callback);

		out = command;
		if (params && params.length) {
			out += ' ' + params;
		}
		self.socket.send(out + "\r\n");
	}
};

instance.prototype.action = function(action) {
	var self = this;

	var cmd = action.action;
	var out;

	if (cmd.match(/^(LOADBG|LOAD|PLAY)$/)) {
		out = cmd + ' ' + parseInt(action.options.channel);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer);
		}

		if (action.options.clip) {
			out += ' ' + AMCP_PARAMETER(action.options.clip);
		} else if (action.options.clip_dd) {
			out += ' ' + AMCP_PARAMETER(action.options.clip_dd);
		}

		if (action.options.loop == 'true') {
			out += ' LOOP';
		}

		if (action.options.transition != 'CUT') {
			out += ' ' + action.options.transition;
			out += ' ' + parseFloat(action.options.transition_duration);
			out += ' ' + AMCP_PARAMETER(action.options.transition_tween);
		}

		if (action.options.auto == 'true') {
			out += ' AUTO';
		}

	} else if (cmd.match(/^(PAUSE|RESUME|STOP|CLEAR)$/)) {
		out = cmd + ' ' + parseInt(action.options.channel);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer);
		}

	} else if (cmd == 'CALL') {
		out = cmd + ' ' + parseInt(action.options.channel);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer);
		}

		// This should not be ACMP_PARAMETER-sanetized, since it is actual commands/parameters
		out += ' ' + action.options.method;

	} else if (cmd == 'SWAP') {
		out = cmd + ' ' + parseInt(action.options.channel1);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer1);
		}

		out += ' ' + parseInt(action.options.channel2);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer2);
		}

		if (action.options.transforms == 'true') {
			out += ' TRANSFORMS';
		}

	} else if (cmd == 'CG ADD') {
		out = 'CG ' + parseInt(action.options.channel);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer);
		}

		out += ' ADD';

		if (action.options.templatelayer != '') {
			out += ' ' + parseInt(action.options.templatelayer)
		}

		if (action.options.template) {
			out += ' ' + AMCP_PARAMETER(action.options.template);
		} else if (action.options.template_dd) {
			out += ' ' + AMCP_PARAMETER(action.options.template_dd);
		}

		if (action.options.playonload == 'true' || action.options.variables != '') {
			out += ' ' + (action.options.playonload == 'true' ? '1' : '0');
		}

		if (action.options.variables != '') {
			var templ = build_templatedata_string(action.options);
			if (templ) {
				out += ' "' + templ.replace(/"/g,'\\"') + '"';
			}
		}

	} else if (cmd == 'CG UPDATE') {
		out = 'CG ' + parseInt(action.options.channel);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer);
		}

		out += ' UPDATE';

		out += ' ' + parseInt(action.options.templatelayer)

		if (action.options.variables != '') {
			var templ = build_templatedata_string(action.options);
			if (templ) {
				out += ' "' + templ.replace(/"/g,'\\"') + '"';
			}
		}

	} else if (cmd == 'CG PLAY') {
		out = 'CG ' + parseInt(action.options.channel);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer);
		}

		out += ' PLAY';

		out += ' ' + parseInt(action.options.templatelayer)

	} else if (cmd == 'CG STOP') {
		out = 'CG ' + parseInt(action.options.channel);

		if (action.options.layer != '') {
			out += '-' + parseInt(action.options.layer);
		}

		out += ' STOP';

		out += ' ' + parseInt(action.options.templatelayer)

	} else if (cmd == 'COMMAND') {
		out = action.options.cmd;
	} else if (cmd == 'GOTO') {
		var params = parseInt(action.options.channel);
		if (action.options.layer != '') {
			params += '-' + parseInt(action.options.layer);
		}

		self.requestData('INFO', params, (data) => self.executeGOTO(data, action.options));
	}

	if (out !== undefined) {

		debug('sending tcp', out, "to", self.config.host);

		if (self.socket !== undefined && self.socket.connected) {
			self.socket.send(out + "\r\n");
		} else {
			debug('Socket not connected :(');
		}

	}
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
