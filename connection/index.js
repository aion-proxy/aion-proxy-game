// TODO ? Cleanup XD

const net = require('net')

const Dispatch = require('./dispatch'),
	  AionCrypto = require('./encryption'),
	  Packetizer = require('../packetizer')

class Connection {
	constructor(dispatch) {
		this.client = null
		this.dispatch = dispatch
		dispatch.connection = this // TODO: Consider refactoring

		this.decryptor = new AionCrypto()
		this.encryptor = new AionCrypto()
		this.packetizer = new Packetizer(data => {
			this.decryptor.decryptServer(data)
			if(this.dispatch) data = this.dispatch.handle(data, true)
			if(data)
				// Note: socket.write() is not thread-safe
				this.sendClient(data.buffer === this.packetizer.buffer.buffer ? Buffer.from(data) : data)
		})
	}

	connect(client, opt) {
		this.client = client
		this.serverConnection = net.connect(opt)
		this.serverConnection.setNoDelay(true)

		this.serverConnection.on('connect', () => {
			this.client.onConnect(this.serverConnection)
		})

		this.serverConnection.on('data', (data) => {
			this.packetizer.recv(data)
		})

		this.serverConnection.on('close', () => {
			this.serverConnection = null
			this.close()
		})

		return this.serverConnection
	}

	sendClient(data) {
		if(this.client) {
		// 	console.log(data.toString('hex')) // debug remove this later
			this.encryptor.encryptServer(data)
			this.client.socket.write(data)
		}
	}
	
	sendServer(data) {
		if(this.serverConnection) {
		//	console.log(data.toString('hex')) // debug remove this later
			this.encryptor.encryptClient(data)
			this.serverConnection.write(data)
		}
	}

	close() {
		if(this.serverConnection) {
			this.serverConnection.end()
			this.serverConnection.unref()
			this.serverConnection = null
		}

		const { client } = this
		if(client) {
			this.client = null // prevent infinite recursion
			client.close()
		}

		if(this.dispatch) {
			this.dispatch.reset()
			this.dispatch = null
		}

		this.decryptor = null
		this.encryptor = null
		this.packetizer = null
	}
}

class RealClient {
	constructor(connection, socket) {
		this.connection = connection
		this.socket = socket

		this.decryptor = null
		this.packetizer = new Packetizer(data => {
			this.connection.decryptor.decryptClient(data)
			if(this.connection.dispatch) data = this.connection.dispatch.handle(data, false)
			if(data)
				// Note: socket.write() is not thread-safe
				this.connection.sendServer(data.buffer === this.packetizer.buffer.buffer ? Buffer.from(data) : data)
		})

		socket.on('data', (data) => {
			this.packetizer.recv(data)
		})

		socket.on('close', () => {
			this.socket = null
			this.close()
		})
	}

	onConnect() {
	}

	close() {
		if(this.socket) {
			this.socket.end()
			this.socket.unref()
			this.socket = null
		}

		const { connection } = this
		if(connection) {
			this.connection = null // prevent infinite recursion
			connection.close()
		}

		this.packetizer = null
	}
}
const crypto = require('crypto')
const events = require('events')
 // Clientless part soonTM
class FakeClient extends events.EventEmitter {
	constructor(connection, keys) {
		super()
		this.connection = connection
		this.connected = false

		if(!keys) {
			keys = [
				crypto.randomBytes(128),
				crypto.randomBytes(128),
			]
		} else {
			if(!Array.isArray(keys)) throw new Error('"keys" must be an array')
			if(keys.length !== 2) throw new Error('client must provide two keys')
			keys.forEach((key) => {
				if(key.length !== 128) {
					throw new Error('keys must be 128 bytes')
				}
			})
		}

		this.keys = keys
	}

	onConnect(serverConnection) {
		serverConnection.on('timeout', () => {
			this.emit('timeout')
		})

		serverConnection.on('error', (err) => {
			this.emit('error', err)
		})
	}

	close() {
		const { connection } = this
		if(connection) {
			this.emit('close')
			this.connection = null // prevent infinite recursion
			connection.close()
		}

		this.keys = null
	}
}

module.exports = {
	Connection: Connection, 
	RealClient: RealClient, 
	FakeClient : FakeClient // soon clientless?
};