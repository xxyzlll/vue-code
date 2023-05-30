## 源码解读进度：
```bash
day1: packages/reactivity/src/baseHandlers.ts
vue3响应式系统的核心代码之一，它通过拦截 JavaScript 对象的属性访问赋值、删除等操作，实现了响应式数据的自动更新，包含了一系列拦截器函数，如 get、set、Property 等，这些函数会在 JavaScript 对象的属性被访问、赋值、删除时被调用。在这些函数中，baseHandlers 会通过 Reflect 对象调用原始的操作，同时记录下这些操作的依赖关系，以便在数据发生变化时自动更新相关的视图。
```