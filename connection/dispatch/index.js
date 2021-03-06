const EventEmitter = require('events'),
	path = require('path'),
	util = require('util'),
	binarySearch = require('binary-search'),
	{ protocol: AionProtocol } = require('aion-data-parser'),
	log = require('../../logger'),
	compat = require('../../compat'),
	Wrapper = require('./wrapper')

const latestDefVersion = new Map()
for(const [name, versions] of AionProtocol.defs)
	latestDefVersion.set(name, Math.max(...versions.keys()))

function* iterateHooks(globalHooks = [], codeHooks = []) {
	const globalHooksIterator = globalHooks[Symbol.iterator](); // .values()
	const codeHooksIterator = codeHooks[Symbol.iterator](); // .values()

	let nextGlobalHook = globalHooksIterator.next()
	let nextCodeHook = codeHooksIterator.next()

	while (!nextGlobalHook.done || !nextCodeHook.done) {
		const globalHookGroup = nextGlobalHook.value
		const codeHookGroup = nextCodeHook.value

		if(globalHookGroup && (!codeHookGroup || globalHookGroup.order <= codeHookGroup.order)) {
			yield* globalHookGroup.hooks
			nextGlobalHook = globalHooksIterator.next()
		} else {
			yield* codeHookGroup.hooks
			nextCodeHook = codeHooksIterator.next()
		}
	}
}

function getHookName(hook) {
	const callbackName = hook.callback ? (hook.callback.name || '(anonymous)') : '<unknown>',
		modName = hook.modName || '<unknown>'
	return `${callbackName} in ${modName}`
}

function getMessageName(map, identifier, version, originalName) {
	if(typeof identifier === 'string') {
		const append = (identifier !== originalName) ? ` (original: "${originalName}")` : ''
		return `${identifier}<${version}>${append}`
	}

	if(typeof identifier === 'number') {
		const name = map.code.get(identifier) || `(opcode ${identifier})`
		return `${name}<${version}>`
	}

	return '(?)'
}

function parseStack(err) {
	const stack = (err && err.stack) || ''
	return stack.split('\n').slice(1).map((line) => {
		if(line.indexOf('(eval ') !== -1) {
			// throw away eval info
			// see <https://github.com/stacktracejs/error-stack-parser/blob/d9eb56a/error-stack-parser.js#L59>
			line = line.replace(/(\(eval at [^()]*)|(\),.*$)/g, '')
		}

		const match = line.match(/^\s*at (?:.+\s+\()?(?:(.+):\d+:\d+|([^)]+))\)?/)
		return match && {
			filename: match[2] || match[1],
			source: line,
		}
	}).filter(Boolean)
}

function errStack(err = new Error(), removeFront = true) {
	const stack = parseStack(err)
	const libPath = /aion-proxy-game[\\/]lib/

	// remove node internals from end
	while (stack.length > 0 && !path.isAbsolute(stack[stack.length - 1].filename)) {
		stack.pop()
	}

	// remove aion-proxy-game internals from end
	while (stack.length > 0 && libPath.test(stack[stack.length - 1].filename)) {
		stack.pop()
	}

	if(removeFront) {
		// remove aion-proxy-game internals from front
		while (stack.length > 0 && libPath.test(stack[0].filename)) {
			stack.shift()
		}
	}

	return stack.map(frame => frame.source).join('\n')
}

function pluralize(number, noun, ext, extNon) { return `${number} ${noun + (number !== 1 ? (ext || 's') : (extNon || ''))}` }

// -----------------------------------------------------------------------------

class Dispatch extends EventEmitter {
	constructor(modManager, protocolVersion) {
		super()

		Object.assign(this, {
			modManager: modManager,
			connection: null,
			loadedMods: new Map(),
			hooks: new Map(), // hooks.set(code, [{order, hooks: [...]}, ...])

			require: new Proxy(Object.create(null), {
				get: (obj, key) => {
					const mod = this.load(key)
					if(!mod) throw Error(`Required mod not found: ${key}`)
					return mod
				},
				set() { throw TypeError('Cannot set property of require')}
			})
		})

		//if(protocolVersion) this.setProtocolVersion(protocolVersion)
	}

	reset() {
		for(const name of this.loadedMods.keys()) this.unload(name, 1) // Run instance destructors
		for(const name of this.loadedMods.keys()) this.unload(name, 2) // Run mod destructors

		this.hooks.clear() // Clean up any broken hooks - TODO: Properly check these and generate warnings
	}

	loadAll() {
		// Statistics
		const startTime = Date.now(),
			count = {true: 0, false: 0}

		for(let name of this.modManager.packages.keys()) count[!!this.load(name)]++

		log.info(`Loaded ${pluralize(count.true, 'mod')} in ${Date.now() - startTime}ms${
			count.false ? log.color('91', ` (${count.false} failed)`) : ''
		}`)
	}

	load(name, hotswapProxy) {
		let mod = this.loadedMods.get(name)
		if(mod !== undefined) return mod.instance

		if(!this.modManager.canLoad(name)) return null

		const pkg = this.modManager.packages.get(name)
		if(!pkg) return null

		log.info(`Loading ${log.color('1', name)}${(() => {
			switch(pkg._compat) {
				case 1: return ` ${log.color('90', '(legacy)')}`
				case 2: return ` ${log.color('90', '(compat)')}`
				default: return ''
			}
		})()}`)

		try {
			const mod = new Wrapper((pkg._compat === 2 ? compat.require : require)(this.modManager.resolve(name)), pkg, this, hotswapProxy)
			this.loadedMods.set(name, mod)
			return mod.instance
		}
		catch (e) {
			log.error(e)

			this.unhookAll(name) // Remove any hooks that may have been added by the broken mod
			this.modManager.brokenMods.add(name)
			return null
		}
	}

	unload(name, multiPass) {
		const mod = this.loadedMods.get(name)
		if(!mod) return false

		this.unhookAll(name)

		try {
			mod.destroy(multiPass)
		}
		catch(e) {
			log.error(`Error running destructor for mod "${name}"`)
			log.error(e)
		}

		if(multiPass !== 1) this.loadedMods.delete(name)
		return true
	}

	reload(name) {
		if(!this.loadedMods.has(name)) throw Error(`Cannot reload unloaded mod: ${name}`)

		const pkg = this.modManager.packages.get(name)
		if(!pkg.reloadable) return false

		const hotswapProxy = this.loadedMods.get(name).instance

		this.unload(name)

		const unloadDir = this.modManager.packages.get(name)._path + path.sep
		for(let file in require.cache)
			if(file.startsWith(unloadDir) && !file.endsWith('.node'))
				delete require.cache[file]

		if(!this.load(name, hotswapProxy)) throw Error(`Failed to reload ${name}`)
		return true
	}

	unhookAll(name) {
		for(const orderings of this.hooks.values())
			for(const ordering of orderings)
				ordering.hooks = ordering.hooks.filter(hook => hook.modName !== name)
	}

	hook(modName, name, version, opts, cb) {
		if(typeof version !== 'number' && version !== '*' && version !== 'raw' && !version?.read)
			throw TypeError(`[dispatch] hook: invalid version specified (${version})`)

		// Parse args
		if(typeof opts === 'function') {
			cb = opts
			opts = {}
		}
		if(typeof cb !== 'function') throw TypeError(`[dispatch] hook: last argument not a function (given: ${typeof cb})`)

		// Retrieve opcode
		let code
		// Wildcard
		if(name === '*') {
			code = '*'
			if(version !== '*' && version !== 'raw')
				throw TypeError(`[dispatch] hook: * hook must request version '*' or 'raw' (given: ${version})`)
		}
		// Named packet
		else {
			// Check if opcode is mapped
			code = this.protocol.packetEnum.name.get(name)
			if(code == null) throw Error(`[dispatch] hook: unmapped packet "${name}"`)

			// Check if definition exists
			if(typeof version === 'number' || version === '*') {
				let def = AionProtocol.defs.get(name)
				if(def) def = version === '*' ? !!def.size : def.has(version)
				if(!def)
					if(latestDefVersion.get(name) > version)
						throw Error(`[dispatch] hook: obsolete defintion (${name}.${version})`)
					else throw Error(`[dispatch] hook: definition not found (${name}.${version})`)
			}

			// TODO: Add deprecation
		}

		// Create hook
		const order = opts.order || 0,
			hook = {
				modName,
				code,
				filter: Object.assign({
					fake: false,
					incoming: null,
					modified: null,
					silenced: false
				}, opts.filter),
				order,
				definitionVersion: version,
				callback: cb,
				timeout: opts.timeout ? setTimeout(() => {
					this.unhook(hook)
					hook.callback(null)
				}, opts.timeout) : null,

				// Callback context
				name
			}

		// Add hook
		if(!this.hooks.has(code)) this.hooks.set(code, [])

		const ordering = this.hooks.get(code),
			index = binarySearch(ordering, { order }, (a, b) => a.order - b.order)

		if(index < 0) ordering.splice(~index, 0, { order, hooks: [hook] })
		else ordering[index].hooks.push(hook)

		return hook
	}

	unhook(hook) {
		if(!hook || !this.hooks.has(hook.code)) return

		const group = this.hooks.get(hook.code).find(o => o.order === hook.order)
		if(group) group.hooks = group.hooks.filter(h => h !== hook)

		if(hook.timeout) clearTimeout(hook.timeout)
	}

	write(outgoing, name, version, data) {
		if(!this.connection) return false

		if(Buffer.isBuffer(name)) data = Buffer.from(name) // Raw mode
		else {
			if(typeof version !== 'number' && version !== '*' && !version?.write)
				throw TypeError(`[dispatch] write: invalid version specified (${version})`)

			if(typeof version === 'number') {
				const latest = latestDefVersion.get(name)
				if(latest && version < latest)
					log.dwarn([
						`[dispatch] write: ${getMessageName(this.protocol.packetEnum, name, version, name)} is not latest version (${latest})`,
						errStack()
					].join('\n'))
			}

			data = this.protocol.write(name, version, data)
		}

		data = this.handle(data, !outgoing, true)
		if(data === false) return false

		this.connection[outgoing ? 'sendServer' : 'sendClient'](data)
		return true
	}

	setProtocolVersion(version) {
		try {
			this.protocol = new AionProtocol(version)
			// TODO: Re-check these and see if they're still needed
			Object.assign(this, {
				protocolVersion: version,
				region: this.protocol.region,
				majorPatchVersion: this.protocol.majorPatchVersion,
				minorPatchVersion: this.protocol.minorPatchVersion,
				sysmsgVersion: this.protocol.sysmsgVersion,
				protocolMap: this.protocol.packetEnum,
				sysmsgMap: this.protocol.sysmsgEnum
			})

			log.info(`Detected protocol version ${version} - patch ${this.protocol.gameVersion}`)

			this.emit('init')
		}
		catch(e) {
			log.error(e)
		}
	}

	// TODO: Probably remove this and use this.protocol.gameVersion
	getPatchVersion() { return this.majorPatchVersion + this.minorPatchVersion/100 }

	// name, version, file
	addDefinition(name, version, file) {
		if(typeof version !== 'number') throw Error('version must be a number')

		const versions = AionProtocol.defs.get(name)
		if(versions && versions.has(version)) return

		AionProtocol.addDef(name, version, file)

		if(!(latestDefVersion.get(name) > version)) latestDefVersion.set(name, version)
	}

	parseSystemMessage(message) {
		if(message[0] !== '@') throw Error(`Invalid system message "${message}" (expected @)`)

		const tokens = message.split('\v'),
			id = tokens[0].substring(1),
			name = id.includes(':') ? id : this.protocol.sysmsgEnum.code.get(parseInt(id))

		if(!name) throw Error(`Unmapped system message ${id} ("${message}")`)

		const data = {}
		for(let i = 2; i < tokens.length; i += 2) data[tokens[i - 1]] = tokens[i]
		return {id: name, tokens: data}
	}

	buildSystemMessage(message, data) {
		if(typeof message === 'string') message = {id: message, tokens: data}
		else {
			const type = message === null ? 'null' : typeof message

			if(type !== 'object') throw TypeError(`Expected object or string, got ${type}`)
			if(!message.id) throw Error('message.id is required')
		}

		const id = message.id.toString().includes(':') ? message.id : this.protocol.sysmsgEnum.name.get(message.id)
		if(!id) throw Error(`Unknown system message "${message.id}"`)

		data = message.tokens

		let str = '@' + id
		for(let key in data) str += `\v${key}\v${data[key]}`
		return str
	}

	handle(data, incoming, fake = false) {
		//console.log('dispatch '+data.toString('hex'))
		const code = data.readUInt16LE(2)
	//	console.log('opcode '+code+' Data: '+data.toString('hex'))
		
		if(code === 72 && !this.protocolVersion) { // CM_VERSION_CHECK
			try {
				
				//const parsed = AionProtocol.parseVersionCheck(data),
				//	shareRevision = parsed.version.find(v => v.index === 0)
				const shareRevision = 50721
					

				if(!shareRevision) {
					log.error([
						'[dispatch] handle: failed to retrieve protocol version from C_CHECK_VERSION<1> (index != 0)',
						`data: ${data.toString('hex')}`
					].join('\n'))
				}
				else this.setProtocolVersion(50721)
				//else this.setProtocolVersion(shareRevision.value)
				
			}
			catch(e) {
				log.error([
					'[dispatch] handle: failed to parse C_CHECK_VERSION<1> for dynamic protocol versioning',
					`data: ${data.toString('hex')}`
				].join('\n'))
				log.error(e)
			}
		}

		const copy = Buffer.from(data)

		const globalHooks = this.hooks.get('*')
		const codeHooks = this.hooks.get(code)
		if(!globalHooks && !codeHooks) return data
		
		let modified = false
		let silenced = false

		function bufferAttachFlags(buf) {
			Object.defineProperties(buf, {
				$fake: { get: () => fake },
				$incoming: { get: () => incoming },
				$modified: { get: () => modified },
				$silenced: { get: () => silenced },
			})
		}

		function objectAttachFlags(obj) {
			Object.defineProperties(obj, {
				$fake: { value: fake },
				$incoming: { value: incoming },
				$modified: { value: modified },
				$silenced: { value: silenced },
			})
		}

		bufferAttachFlags(data)

		for(const hook of iterateHooks(globalHooks, codeHooks)) {
			// check flags
			const { filter } = hook
			if(filter.fake != null && filter.fake !== fake) continue
			if(filter.incoming != null && filter.incoming !== incoming) continue
			if(filter.modified != null && filter.modified !== modified) continue
			if(filter.silenced != null && filter.silenced !== silenced) continue

			if(hook.definitionVersion === 'raw')
				try {
					const result = hook.callback(code, data, incoming, fake)

					if(Buffer.isBuffer(result) && result !== data) {
						modified = modified || (result.length !== data.length) || !result.equals(data)
						bufferAttachFlags(result)
						data = result
					} else {
						modified = modified || !data.equals(copy)
						if(typeof result === 'boolean') silenced = !result
					}
				}
				catch(e) {
					log.error([
						`[dispatch] handle: error running raw hook for ${getMessageName(this.protocol.packetEnum, code, hook.definitionVersion)}`,
						`hook: ${getHookName(hook)}`,
						`data: ${data.toString('hex')}`,
						`error: ${e.message}`,
						errStack(e),
					].join('\n'))
					continue
				}
			else { // normal hook
				try {
					const defVersion = hook.definitionVersion,
						event = this.protocol.read(code, defVersion, data)

					objectAttachFlags(event)

					try {
						const result = hook.callback(event, fake)

						if(result === true) {
							modified = true
							silenced = false

							try {
								data = this.protocol.write(code, defVersion, event)
								bufferAttachFlags(data)
							}
							catch(e) {
								log.error([
									`[dispatch] handle: failed to generate ${getMessageName(this.protocol.packetEnum, code, defVersion)}`,
									`hook: ${getHookName(hook)}`,
									`error: ${e.message}`,
									errStack(e, false),
								].join('\n'))
							}
						}
						else if(result === false) silenced = true
					}
					catch(e) {
						log.error([
							`[dispatch] handle: error running hook for ${getMessageName(this.protocol.packetEnum, code, defVersion)}`,
							`hook: ${getHookName(hook)}`,
							`data: ${util.inspect(event)}`,
							`error: ${e.message}`,
							errStack(e),
						].join('\n'))
					}
				}
				catch(e) {
					log.error([
						`[dispatch] handle: failed to parse ${getMessageName(this.protocol.packetEnum, code, hook.definitionVersion)}`,
						`hook: ${getHookName(hook)}`,
						`data: ${data.toString('hex')}`,
						`error: ${e.message}`,
						errStack(e, false),
					].join('\n'))
				}
			}
		}

		if(silenced) return false

		return data
	}
}

module.exports = Dispatch