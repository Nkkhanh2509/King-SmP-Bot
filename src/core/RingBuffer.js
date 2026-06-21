'use strict';
class RingBuffer {
  constructor(capacity = 800) {
    this._cap = Math.max(1, capacity);
    this._buf = new Array(this._cap);
    this._head = 0;
    this._size = 0;
  }
  push(item) {
    this._buf[this._head % this._cap] = item;
    this._head++;
    if (this._head > 0x3FFFFFFF) {
      this._head = this._size;
    }
    if (this._size < this._cap) this._size++;
  }
  toArray() {
    if (this._size === 0) return [];
    const start = this._head - this._size;
    const out = [];
    for (let i = 0; i < this._size; i++) {
      out.push(this._buf[(start + i) % this._cap]);
    }
    return out;
  }
  clear() {
    this._head = 0;
    this._size = 0;
  }
  get length() { return this._size; }
  get capacity() { return this._cap; }
}
module.exports = RingBuffer;
