const { Regex, InstanceBase, runEntrypoint, TCPHelper, InstanceStatus } = require('@companion-module/base')
const { parseString } = require('xml2js')
const compileActionDefinitions = require('./actions')

class instance extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.response_callback = {}

		this.CHOICES_TEMPLATES = []
		this.CHOICES_MEDIAFILES = []
	}

	async init(config) {
		this.config = config

		this.init_actions() // export actions

		this.init_tcp()
	}

	async configUpdated(config) {
		this.config = config

		this.init_tcp()
	}

	// When module gets deleted
	async destroy() {
		if (this.socket) {
			this.socket.destroy()
		}
	}

	// Return config fields for web config
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'IP Address of CasparCG Server',
				width: 6,
				default: '',
				regex: Regex.IP,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'AMCP TCP Port',
				default: 5250,
				regex: Regex.PORT,
			},
		]
	}

	init_tcp() {
		const ACMP_STATE = {
			NEXT: 0,
			SINGLE_LINE: 1,
			MULTI_LINE: 2,
		}

		const RETCODE = {
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
			ACCESS_ERROR: 503,
		}
		const RETCODE2TYPE = swap_obj(RETCODE)

		if (this.socket) {
			this.updateStatus(InstanceStatus.Disconnected)
			this.socket.destroy()
			delete this.socket
		}

		if (this.config.host) {
			this.updateStatus(InstanceStatus.Connecting)

			this.socket = new TCPHelper(this.config.host, this.config.port || 5250)

			this.socket.on('status_change', (status, message) => {
				this.updateStatus(status, message)
			})

			this.socket.on('error', (err) => {
				this.log('error', 'Network error: ' + err.message)
			})

			this.socket.on('connect', () => {
				this.log('debug', 'Connected')

				this.requestData('CLS', null, this.handleCLS.bind(this))
				this.requestData('TLS', null, this.handleTLS.bind(this))
			})

			let receivebuffer = ''
			let amcp_state = ACMP_STATE.NEXT
			let error_code = undefined
			let multilinedata = []
			let response_current = ''

			// separate buffered stream into lines with responses
			this.socket.on('data', (chunk) => {
				var i = 0,
					line = '',
					offset = 0
				receivebuffer += chunk

				while ((i = receivebuffer.indexOf('\r\n', offset)) !== -1) {
					line = receivebuffer.substr(offset, i - offset)
					offset = i + 2
					this.socket.emit('receiveline', line.toString())
				}

				receivebuffer = receivebuffer.substr(offset)
			})

			this.socket.on('receiveline', (line) => {
				let error = false

				// New message
				if (amcp_state == ACMP_STATE.NEXT) {
					let code = line.match(/^(\d+)\s+(\S*)/)
					let status
					if (code && code.length > 1) {
						if (code.length > 2) {
							status = code[2]
						}

						code = parseInt(code[1])
					} else {
						this.log('error', 'Protocol out of sync, expected number: ' + line)
						return
					}

					switch (code) {
						case RETCODE.INVALID_CHANNEL:
						case RETCODE.PARAMETER_MISSING:
						case RETCODE.PARAMETER_ILLEGAL:
						case RETCODE.MEDIAFILE_NOT_FOUND:
						case RETCODE.INTERNAL_SERVER_ERROR:
						case RETCODE.MEDIAFILE_UNREADABLE:
						case RETCODE.ACCESS_ERROR:
							error = true
							error_code = code
							// Explicit for readability
							amcp_state = ACMP_STATE.NEXT
							break

						case RETCODE.INFO:
						case RETCODE.OK:
							// Explicit for readability
							amcp_state = ACMP_STATE.NEXT
							error_code = undefined
							break

						case RETCODE.COMMAND_UNKNOWN_DATA:
						case RETCODE.INTERNAL_SERVER_ERROR_DATA:
							error = true
							error_code = code
							amcp_state = ACMP_STATE.SINGLE_LINE
							break

						case RETCODE.INFODATA:
						case RETCODE.OKDATA:
							amcp_state = ACMP_STATE.SINGLE_LINE
							response_current = status
							error_code = undefined
							break

						case RETCODE.OKMULTIDATA:
							amcp_state = ACMP_STATE.MULTI_LINE
							response_current = status
							error_code = undefined
							multilinedata = []
							break

						default:
							this.log('error', 'Unrecognized data from server: ' + line)
							return
					}

					if (error && amcp_state == ACMP_STATE.NEXT) {
						this.log('error', 'Got error ' + RETCODE2TYPE[code] + ': ' + line)
					}
				}

				// Current line is a single-line response to last message
				else if (amcp_state == ACMP_STATE.SINGLE_LINE) {
					amcp_state = ACMP_STATE.NEXT

					if (error_code !== undefined) {
						this.log('error', 'Got error ' + RETCODE2TYPE[error_code] + ': ' + line)
					} else {
						response_current = response_current.toUpperCase()

						if (
							this.response_callback[response_current] !== undefined &&
							this.response_callback[response_current].length
						) {
							const cb = this.response_callback[response_current].shift()

							if (typeof cb == 'function') {
								cb(line)
								response_current = ''
							}
						}
					}
				}

				// Current line is part of a multi-line response
				else if (amcp_state == ACMP_STATE.MULTI_LINE) {
					if (line == '') {
						amcp_state = ACMP_STATE.NEXT

						response_current = response_current.toUpperCase()

						if (
							this.response_callback[response_current] !== undefined &&
							this.response_callback[response_current].length
						) {
							const cb = this.response_callback[response_current].shift()

							if (typeof cb == 'function') {
								cb(multilinedata)
								multilinedata.length = 0
								response_current = ''
							}
						}
					} else {
						multilinedata.push(line)
					}
				}
			})
		}
	}

	handleCLS(data) {
		this.CHOICES_MEDIAFILES.length = 0

		for (let i = 0; i < data.length; ++i) {
			const match = data[i].match(/^"([^"]+)"/)
			if (match && match.length > 1) {
				const file = match[1].replace(/\\/g, '\\\\')
				this.CHOICES_MEDIAFILES.push({ label: file, id: file })
			}
		}

		this.init_actions()
	}

	handleTLS(data) {
		this.CHOICES_TEMPLATES.length = 0

		for (let i = 0; i < data.length; ++i) {
			// Template response parsing from SuperFlyTv/casparcg-connection
			// https://github.com/SuperFlyTV/casparcg-connection/blob/master/src/lib/ResponseParsers.ts#L320
			const match = data[i].match(/\"(.*?)\" +(.*)/)
			let file = null
			if (match === null) {
				// propably 2.2.0
				file = data[i]
			} else {
				// is 2.0.7 or 2.1.0 template
				file = match[1]
			}

			if (file !== null) {
				file = file.replace(/\\/g, '\\\\')
				this.CHOICES_TEMPLATES.push({ label: file, id: file })
			}
		}

		this.init_actions()
	}
	executeGOTO(data, options) {
		if (!data || !data.length || !options) {
			return
		}

		parseString(data, (err, result) => {
			if (err) {
				this.log('debug', 'Error in INFO response: ' + err)
			} else {
				try {
					var offset = parseInt(options.offset)

					var framerate = 0
					var seek = 0
					if (result.layer) {
						// CasparCG 2.0.7 or 2.1.0
						framerate = parseInt(result.layer.foreground[0].producer[0].fps[0])

						if (offset >= 0) {
							seek = offset * framerate
						} else {
							var clipFrames = parseInt(result.layer.foreground[0].producer[0]['nb-frames'][0])
							seek = Math.floor(clipFrames + offset * framerate)
						}
					} else if (result.channel) {
						// CasparCG 2.2.0
						framerate = parseInt(result.channel.framerate[0])

						if (offset >= 0) {
							seek = offset * framerate
						} else {
							var clipLength = parseFloat(
								result.channel.stage[0].layer[0]['layer_' + options.layer][0].foreground[0].file[0].clip[1]
							)
							seek = Math.floor(clipLength + offset) * framerate
						}
					}

					if (framerate > 0) {
						var out = 'CALL ' + parseInt(options.channel)
						if (options.layer != '') {
							out += '-' + parseInt(options.layer)
						}
						out += ' SEEK ' + seek

						if (this.socket !== undefined && this.socket.isConnected) {
							this.socket.send(out + '\r\n')
						}
					}
				} catch (e) {
					this.log('debug', 'Error in INFO response: ' + e)
				}
			}
		})
	}
	init_actions() {
		this.setActionDefinitions(compileActionDefinitions(this))
	}
	requestData(command, params, callback) {
		if (this.socket && this.socket.isConnected) {
			command = command.toUpperCase()

			if (this.response_callback[command] === undefined) {
				this.response_callback[command] = []
			}

			this.response_callback[command].push(callback)

			let out = command
			if (params && params.length) {
				out += ' ' + params
			}
			this.socket.send(out + '\r\n')
		}
	}
}

function swap_obj(obj) {
	let ret = {}

	for (var key in obj) {
		ret[obj[key]] = key
	}

	return ret
}

runEntrypoint(instance, [])
