import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

// 判断一个属性名是否为不可追踪的属性名
// Vue 3 的响应式系统中，只有被追踪的属性才能触发依赖更新，不可追踪的属性则不会触发依赖更新
const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  // Object.getOwnPropertyNames 方法只能获取到对象自身的属性名，而不能获取到原型链上的属性名
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function

    // 使用 filter 方法过滤掉 arguments 和 caller 这两个属性名
    // ## 某些旧版本的浏览器中，Object.getOwnPropertyNames(Symbol) 可能会返回 caller 和 arguments，新版本浏览器一般不会
    // 因为在某些环境下，这两个属性名可能会导致 TypeError 错误，Symbol 是严格模式
    // 这个过滤操作在现代浏览器中并不会有任何影响，但是为了保证代码的兼容性，Vue 3 的源码中还是加入了这个过滤操作
    .filter(key => key !== 'arguments' && key !== 'caller')
    // 将 Symbol 对象的属性名转换为对应的 Symbol 对象
    .map(key => (Symbol as any)[key])
    // 过滤掉非 Symbol 对象
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

// 创建 Vue 3 中的数组代理对象的方法。这些方法包括一些数组的常用方法
// 如 push、pop、shift、unshift、splice、includes、indexOf 和 lastIndexOf
// 用于创建数组代理对象的的工厂函数，用于拦截数组的访问和修改，并在访问和修改时进行依赖收集
function createArrayInstrumentations() {
  // 存储数组方法
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  // 对这三个方法定义代理函数，用于拦截数组的访问，并在访问时进行依赖收集
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // 对这五个方法定义代理函数，用于拦截数组修改，并在修改时暂停依赖收集，以避免无限循环
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  return instrumentations
}

// 判断一个对象是否具有指定的属性
function hasOwnProperty(this: object, key: string) {
  // toRaw：将响应式对象转换为原始对象
  const obj = toRaw(this)
  // 追踪 obj 对象的 key 属性的访问情况
  // track：工具函数，追踪响应式对象的属性访问情况
  track(obj, TrackOpTypes.HAS, key)
  // 判断 obj 对象是否具有 key 属性
  return obj.hasOwnProperty(key)
}

// 创建 Vue 3 中的代理对象的 getter 函数。这个 getter 函数用于拦截对象属性的访问。
// createGetter 函数接受两个参数：isReadonly 和 shallow，分别表示是否创建只读代理和是否创建浅层代理。
function createGetter(isReadonly = false, shallow = false) {
  // 返回一个名为 get 的函数，它接受三个参数：target（被代理的对象）、key（访问的属性名）和 receiver（代理对象）
  return function get(target: Target, key: string | symbol, receiver: object) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      // 是否为响应式对象
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      // 是否为只读对象
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      // 是否为浅层代理
      return shallow
    } else if (
      // 访问的属性是 ReactiveFlags.RAW 且 receiver 是当前代理对象
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target
    }

    // 判断 target 是否为数组
    const targetIsArray = isArray(target)

    if (!isReadonly) {
      // 不是只读代理，且 target 是数组并访问了特定的数组方法
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        // 返回数组方法的代理
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
      // 如果访问的属性是 hasOwnProperty，返回 hasOwnProperty 函数
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    const res = Reflect.get(target, key, receiver)

    // 如果访问的属性是内置 Symbol 或不可跟踪的属性，直接返回 res
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 不是只读代理，收集 target 的依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 是浅层代理
    if (shallow) {
      return res
    }

    // 是 ref 对象，对其进行解包
    // 数组和整数，跳过解包
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    // 是对象，将其转换为代理对象 根据 isReadonly 返回只读代理或响应式代理
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

// 拦截对象属性的设置。createSetter 函数接受一个参数：shallow，表示是否创建浅层代理
function createSetter(shallow = false) {
  // target（被代理的对象）、key（设置的属性名）、value（设置的属性值）、 receiver（代理对象）
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    // 获取 target 对象上的旧值 oldValue
    let oldValue = (target as any)[key]

    // 只读的 ref 对象且 value 不是 ref 对象
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      // 不允许设置
      return false
    }
    // 不是浅层代理
    if (!shallow) {
      // 解包 ref 对象
      // 获取原始对象
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
  // 是浅层代理，对象将按原本设置，无论是否为响应式对象
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 判断 target 对象是否已经具有该属性
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)

    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    //  如果 target 是原始 receiver 对象，根据属性是否存在以及值是否发生变化，触发相应的依赖更新
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

// 对象的指定属性，并在响应式系统中触发该属性的删除操作
function deleteProperty(target: object, key: string | symbol): boolean {
  // 判断 target 对象是否具有 key 属性
  // hasOwn：工具函数，判断一个对象是否具有指定的属性
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]

  // 使用 Reflect.deleteProperty 方法删除 target 对象的 key 属性，并将结果存储到 result 
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    // 删除成功使用 trigger函数触发target对象的 key 属性的删除操作
    // trigger：工具函数，触发响应式对象的属性操作
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

// 判断一个对象是否具有指定的属性，并在响应式系统中追踪该属性的访问情况
function has(target: object, key: string | symbol): boolean {
  // 判断 target 对象是否具有 key 属性
  const result = Reflect.has(target, key)
  // 如果 key 不是 Symbol 类型，或者 key 是内置的 Symbol 对象之一（即 builtInSymbols 对象中包含 key）
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    // 追踪 target 对象的 key 属性的访问情况
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

// 获取一个对象的所有属性名，并在响应式系统中追踪该对象的迭代操作
function ownKeys(target: object): (string | symbol)[] {
  // 追踪 target 对象的迭代操作，并将属性名作为参数传递给 track 函数
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  // 获取 target 对象的所有属性名并返回
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
