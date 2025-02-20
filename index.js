'use strict'

const fs = require('fs')
const EventEmitter = require('events')
const inherits = require('util').inherits
const path = require('path')
const sleep = require('atomic-sleep')

const BUSY_WRITE_TIMEOUT = 100
const kEmptyBuffer = Buffer.allocUnsafe(0)

// 16 KB. Don't write more than docker buffer size.
// https://github.com/moby/moby/blob/513ec73831269947d38a644c278ce3cac36783b2/daemon/logger/copier.go#L13
const MAX_WRITE = 16 * 1024

const kContentModeBuffer = 'buffer'
const kContentModeUtf8 = 'utf8'

function openFile (file, sonic) {
  sonic._opening = true
  sonic._writing = true
  sonic._asyncDrainScheduled = false

  // NOTE: 'error' and 'ready' events emitted below only relevant when sonic.sync===false
  // for sync mode, there is no way to add a listener that will receive these

  function fileOpened (err, fd) {
    if (err) {
      sonic._reopening = false
      sonic._writing = false
      sonic._opening = false

      if (sonic.sync) {
        process.nextTick(() => {
          if (sonic.listenerCount('error') > 0) {
            sonic.emit('error', err)
          }
        })
      } else {
        sonic.emit('error', err)
      }
      return
    }

    sonic.fd = fd
    sonic.file = file
    sonic._reopening = false
    sonic._opening = false
    sonic._writing = false

    if (sonic.sync) {
      process.nextTick(() => sonic.emit('ready'))
    } else {
      sonic.emit('ready')
    }

    if (sonic._reopening) {
      return
    }

    // start
    if (!sonic._writing && sonic._len > sonic.minLength && !sonic.destroyed) {
      sonic._actualWrite()
    }
  }

  const flags = sonic.append ? 'a' : 'w'
  const mode = sonic.mode

  if (sonic.sync) {
    try {
      if (sonic.mkdir) fs.mkdirSync(path.dirname(file), { recursive: true })
      const fd = fs.openSync(file, flags, mode)
      fileOpened(null, fd)
    } catch (err) {
      fileOpened(err)
      throw err
    }
  } else if (sonic.mkdir) {
    fs.mkdir(path.dirname(file), { recursive: true }, (err) => {
      if (err) return fileOpened(err)
      fs.open(file, flags, mode, fileOpened)
    })
  } else {
    fs.open(file, flags, mode, fileOpened)
  }
}

function SonicBoom (opts) {
  if (!(this instanceof SonicBoom)) {
    return new SonicBoom(opts)
  }

  let { fd, dest, minLength, maxLength, maxWrite, sync, append = true, mkdir, retryEAGAIN, fsync, contentMode, mode } = opts || {}

  fd = fd || dest

  this._len = 0
  this.fd = -1
  this._bufs = []
  this._lens = []
  this._writing = false
  this._ending = false
  this._reopening = false
  this._asyncDrainScheduled = false
  this._hwm = Math.max(minLength || 0, 16387)
  this.file = null
  this.destroyed = false
  this.minLength = minLength || 0
  this.maxLength = maxLength || 0
  this.maxWrite = maxWrite || MAX_WRITE
  this.sync = sync || false
  this.writable = true
  this._fsync = fsync || false
  this.append = append || false
  this.mode = mode
  this.retryEAGAIN = retryEAGAIN || (() => true)
  this.mkdir = mkdir || false

  let fsWriteSync
  let fsWrite
  if (contentMode === kContentModeBuffer) {
    this._writingBuf = kEmptyBuffer
    this.write = writeBuffer
    this.flush = flushBuffer
    this.flushSync = flushBufferSync
    this._actualWrite = actualWriteBuffer
    fsWriteSync = () => fs.writeSync(this.fd, this._writingBuf)
    fsWrite = () => fs.write(this.fd, this._writingBuf, this.release)
  } else if (contentMode === undefined || contentMode === kContentModeUtf8) {
    this._writingBuf = ''
    this.write = write
    this.flush = flush
    this.flushSync = flushSync
    this._actualWrite = actualWrite
    fsWriteSync = () => fs.writeSync(this.fd, this._writingBuf, 'utf8')
    fsWrite = () => fs.write(this.fd, this._writingBuf, 'utf8', this.release)
  } else {
    throw new Error(`SonicBoom supports "${kContentModeUtf8}" and "${kContentModeBuffer}", but passed ${contentMode}`)
  }

  if (typeof fd === 'number') {
    this.fd = fd
    process.nextTick(() => this.emit('ready'))
  } else if (typeof fd === 'string') {
    openFile(fd, this)
  } else {
    throw new Error('SonicBoom supports only file descriptors and files')
  }
  if (this.minLength >= this.maxWrite) {
    throw new Error(`minLength should be smaller than maxWrite (${this.maxWrite})`)
  }

  this.release = (err, n) => {
    if (err) {
      if ((err.code === 'EAGAIN' || err.code === 'EBUSY') && this.retryEAGAIN(err, this._writingBuf.length, this._len - this._writingBuf.length)) {
        if (this.sync) {
          // This error code should not happen in sync mode, because it is
          // not using the underlining operating system asynchronous functions.
          // However it happens, and so we handle it.
          // Ref: https://github.com/pinojs/pino/issues/783
          try {
            sleep(BUSY_WRITE_TIMEOUT)
            this.release(undefined, 0)
          } catch (err) {
            this.release(err)
          }
        } else {
          // Let's give the destination some time to process the chunk.
          setTimeout(fsWrite, BUSY_WRITE_TIMEOUT)
        }
      } else {
        this._writing = false

        this.emit('error', err)
      }
      return
    }

    this.emit('write', n)

    this._len -= n
    // In case of multi-byte characters, the length of the written buffer
    // may be different from the length of the string. Let's make sure
    // we do not have an accumulated string with a negative length.
    // This also mean that ._len is not precise, but it's not a problem as some
    // writes might be triggered earlier than ._minLength.
    if (this._len < 0) {
      this._len = 0
    }

    // TODO if we have a multi-byte character in the buffer, we need to
    // n might not be the same as this._writingBuf.length, so we might loose
    // characters here. The solution to this problem is to use a Buffer for _writingBuf.
    this._writingBuf = this._writingBuf.slice(n)

    if (this._writingBuf.length) {
      if (!this.sync) {
        fsWrite()
        return
      }

      try {
        do {
          const n = fsWriteSync()
          this._len -= n
          this._writingBuf = this._writingBuf.slice(n)
        } while (this._writingBuf.length)
      } catch (err) {
        this.release(err)
        return
      }
    }

    if (this._fsync) {
      fs.fsyncSync(this.fd)
    }

    const len = this._len
    if (this._reopening) {
      this._writing = false
      this._reopening = false
      this.reopen()
    } else if (len > this.minLength) {
      this._actualWrite()
    } else if (this._ending) {
      if (len > 0) {
        this._actualWrite()
      } else {
        this._writing = false
        actualClose(this)
      }
    } else {
      this._writing = false
      if (this.sync) {
        if (!this._asyncDrainScheduled) {
          this._asyncDrainScheduled = true
          process.nextTick(emitDrain, this)
        }
      } else {
        this.emit('drain')
      }
    }
  }

  this.on('newListener', function (name) {
    if (name === 'drain') {
      this._asyncDrainScheduled = false
    }
  })
}

function emitDrain (sonic) {
  const hasListeners = sonic.listenerCount('drain') > 0
  if (!hasListeners) return
  sonic._asyncDrainScheduled = false
  sonic.emit('drain')
}

inherits(SonicBoom, EventEmitter)

function mergeBuf (bufs, len) {
  if (bufs.length === 0) {
    return kEmptyBuffer
  }

  if (bufs.length === 1) {
    return bufs[0]
  }

  return Buffer.concat(bufs, len)
}

function write (data) {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  const len = this._len + data.length
  const bufs = this._bufs

  if (this.maxLength && len > this.maxLength) {
    this.emit('drop', data)
    return this._len < this._hwm
  }

  if (
    bufs.length === 0 ||
    bufs[bufs.length - 1].length + data.length > this.maxWrite
  ) {
    bufs.push('' + data)
  } else {
    bufs[bufs.length - 1] += data
  }

  this._len = len

  if (!this._writing && this._len >= this.minLength) {
    this._actualWrite()
  }

  return this._len < this._hwm
}

function writeBuffer (data) {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  const len = this._len + data.length
  const bufs = this._bufs
  const lens = this._lens

  if (this.maxLength && len > this.maxLength) {
    this.emit('drop', data)
    return this._len < this._hwm
  }

  if (
    bufs.length === 0 ||
    lens[lens.length - 1] + data.length > this.maxWrite
  ) {
    bufs.push([data])
    lens.push(data.length)
  } else {
    bufs[bufs.length - 1].push(data)
    lens[lens.length - 1] += data.length
  }

  this._len = len

  if (!this._writing && this._len >= this.minLength) {
    this._actualWrite()
  }

  return this._len < this._hwm
}

function callFlushCallbackOnDrain (cb) {
  const onDrain = () => {
    // only if _fsync is false to avoid double fsync
    if (!this._fsync) {
      fs.fsync(this.fd, cb)
    } else {
      cb()
    }
    this.off('error', onError)
  }
  const onError = (err) => {
    cb(err)
    this.off('drain', onDrain)
  }

  this.once('drain', onDrain)
  this.once('error', onError)
}

function flush (cb) {
  if (cb != null && typeof cb !== 'function') {
    throw new Error('flush cb must be a function')
  }

  if (this.destroyed) {
    const error = new Error('SonicBoom destroyed')
    if (cb) {
      cb(error)
      return
    }

    throw error
  }

  if (this.minLength <= 0) {
    cb?.()
    return
  }

  if (cb) {
    callFlushCallbackOnDrain.call(this, cb)
  }

  if (this._writing) {
    return
  }

  if (this._bufs.length === 0) {
    this._bufs.push('')
  }

  this._actualWrite()
}

function flushBuffer (cb) {
  if (cb != null && typeof cb !== 'function') {
    throw new Error('flush cb must be a function')
  }

  if (this.destroyed) {
    const error = new Error('SonicBoom destroyed')
    if (cb) {
      cb(error)
      return
    }

    throw error
  }

  if (this.minLength <= 0) {
    cb?.()
    return
  }

  if (cb) {
    callFlushCallbackOnDrain.call(this, cb)
  }

  if (this._writing) {
    return
  }

  if (this._bufs.length === 0) {
    this._bufs.push([])
    this._lens.push(0)
  }

  this._actualWrite()
}

SonicBoom.prototype.reopen = function (file) {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this._opening) {
    this.once('ready', () => {
      this.reopen(file)
    })
    return
  }

  if (this._ending) {
    return
  }

  if (!this.file) {
    throw new Error('Unable to reopen a file descriptor, you must pass a file to SonicBoom')
  }

  this._reopening = true

  if (this._writing) {
    return
  }

  const fd = this.fd
  this.once('ready', () => {
    if (fd !== this.fd) {
      fs.close(fd, (err) => {
        if (err) {
          return this.emit('error', err)
        }
      })
    }
  })

  openFile(file || this.file, this)
}

SonicBoom.prototype.end = function () {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this._opening) {
    this.once('ready', () => {
      this.end()
    })
    return
  }

  if (this._ending) {
    return
  }

  this._ending = true

  if (this._writing) {
    return
  }

  if (this._len > 0 && this.fd >= 0) {
    this._actualWrite()
  } else {
    actualClose(this)
  }
}

function flushSync () {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this.fd < 0) {
    throw new Error('sonic boom is not ready yet')
  }

  if (!this._writing && this._writingBuf.length > 0) {
    this._bufs.unshift(this._writingBuf)
    this._writingBuf = ''
  }

  let buf = ''
  while (this._bufs.length || buf) {
    if (buf.length <= 0) {
      buf = this._bufs[0]
    }
    try {
      const n = fs.writeSync(this.fd, buf, 'utf8')
      buf = buf.slice(n)
      this._len = Math.max(this._len - n, 0)
      if (buf.length <= 0) {
        this._bufs.shift()
      }
    } catch (err) {
      const shouldRetry = err.code === 'EAGAIN' || err.code === 'EBUSY'
      if (shouldRetry && !this.retryEAGAIN(err, buf.length, this._len - buf.length)) {
        throw err
      }

      sleep(BUSY_WRITE_TIMEOUT)
    }
  }
}

function flushBufferSync () {
  if (this.destroyed) {
    throw new Error('SonicBoom destroyed')
  }

  if (this.fd < 0) {
    throw new Error('sonic boom is not ready yet')
  }

  if (!this._writing && this._writingBuf.length > 0) {
    this._bufs.unshift([this._writingBuf])
    this._writingBuf = kEmptyBuffer
  }

  let buf = kEmptyBuffer
  while (this._bufs.length || buf.length) {
    if (buf.length <= 0) {
      buf = mergeBuf(this._bufs[0], this._lens[0])
    }
    try {
      const n = fs.writeSync(this.fd, buf)
      buf = buf.subarray(n)
      this._len = Math.max(this._len - n, 0)
      if (buf.length <= 0) {
        this._bufs.shift()
        this._lens.shift()
      }
    } catch (err) {
      const shouldRetry = err.code === 'EAGAIN' || err.code === 'EBUSY'
      if (shouldRetry && !this.retryEAGAIN(err, buf.length, this._len - buf.length)) {
        throw err
      }

      sleep(BUSY_WRITE_TIMEOUT)
    }
  }
}

SonicBoom.prototype.destroy = function () {
  if (this.destroyed) {
    return
  }
  actualClose(this)
}

function actualWrite () {
  const release = this.release
  this._writing = true
  this._writingBuf = this._writingBuf || this._bufs.shift() || ''

  if (this.sync) {
    try {
      const written = fs.writeSync(this.fd, this._writingBuf, 'utf8')
      release(null, written)
    } catch (err) {
      release(err)
    }
  } else {
    fs.write(this.fd, this._writingBuf, 'utf8', release)
  }
}

function actualWriteBuffer () {
  const release = this.release
  this._writing = true
  this._writingBuf = this._writingBuf.length ? this._writingBuf : mergeBuf(this._bufs.shift(), this._lens.shift())

  if (this.sync) {
    try {
      const written = fs.writeSync(this.fd, this._writingBuf)
      release(null, written)
    } catch (err) {
      release(err)
    }
  } else {
    fs.write(this.fd, this._writingBuf, release)
  }
}

function actualClose (sonic) {
  if (sonic.fd === -1) {
    sonic.once('ready', actualClose.bind(null, sonic))
    return
  }

  sonic.destroyed = true
  sonic._bufs = []
  sonic._lens = []

  fs.fsync(sonic.fd, closeWrapped)

  function closeWrapped () {
    // We skip errors in fsync

    if (sonic.fd !== 1 && sonic.fd !== 2) {
      fs.close(sonic.fd, done)
    } else {
      done()
    }
  }

  function done (err) {
    if (err) {
      sonic.emit('error', err)
      return
    }

    if (sonic._ending && !sonic._writing) {
      sonic.emit('finish')
    }
    sonic.emit('close')
  }
}

/**
 * These export configurations enable JS and TS developers
 * to consumer SonicBoom in whatever way best suits their needs.
 * Some examples of supported import syntax includes:
 * - `const SonicBoom = require('SonicBoom')`
 * - `const { SonicBoom } = require('SonicBoom')`
 * - `import * as SonicBoom from 'SonicBoom'`
 * - `import { SonicBoom } from 'SonicBoom'`
 * - `import SonicBoom from 'SonicBoom'`
 */
SonicBoom.SonicBoom = SonicBoom
SonicBoom.default = SonicBoom
module.exports = SonicBoom
