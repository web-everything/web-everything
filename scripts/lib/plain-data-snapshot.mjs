/** Copy caller data without invoking accessors, iterators or Proxy traps. */
import { types } from 'node:util';

export function snapshotInput(value, ancestors = new Set()) {
  // Descriptor inspection alone cannot identify a Proxy: its traps can forge descriptors.
  if (types.isProxy(value)) throw new SyntaxError('Proxy input is unsupported; use literal argv and plain data');
  if (value === null || typeof value !== 'object') return value;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
    throw new SyntaxError('non-plain input is unsupported; use literal argv and plain data');
  }
  if (ancestors.has(value)) throw new SyntaxError('cyclic input is unsupported; use literal argv and plain data');
  ancestors.add(value);
  const copy = array ? [] : Object.create(null);
  let indices = 0, length;
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) {
      throw new SyntaxError('accessor input is unsupported; use literal argv and plain data');
    }
    if (array && key === 'length') { length = property.value; continue; }
    if (array) {
      if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= 0xffffffff) {
        throw new SyntaxError('non-plain array is unsupported; use literal argv without custom properties');
      }
      indices++;
    }
    Object.defineProperty(copy, key, { value: snapshotInput(property.value, ancestors), enumerable: true });
  }
  if (array && indices !== length) throw new SyntaxError('sparse array is unsupported; use literal argv with dense arrays');
  ancestors.delete(value);
  return Object.freeze(copy);
}

