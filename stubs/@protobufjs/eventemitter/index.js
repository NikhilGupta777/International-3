function EventEmitter() { this._listeners = {}; }
EventEmitter.prototype.on = function(e, fn) { (this._listeners[e] = this._listeners[e] || []).push(fn); return this; };
EventEmitter.prototype.off = function(e, fn) { if (this._listeners[e]) this._listeners[e] = this._listeners[e].filter(f => f !== fn); return this; };
EventEmitter.prototype.emit = function(e) { const args = Array.prototype.slice.call(arguments, 1); (this._listeners[e] || []).forEach(f => f.apply(this, args)); return this; };
module.exports = EventEmitter;