---
name: vue-component
description: Conventions for writing or refactoring Vue 3 single-file components with TypeScript (script setup, props, emits, composables). Use when creating or changing a .vue file.
---
# Vue 3 component conventions

## Structure
- Use `<script setup lang="ts">`, then `<template>`, then `<style scoped>`.
- One component per file; file name in PascalCase (`UserCard.vue`).

## Props and emits
- Type props with an interface and `defineProps<Props>()`; use `withDefaults` for defaults.
- Declare events with typed `defineEmits<{ (e: "update:modelValue", value: string): void }>()`.
- For two-way binding prefer `defineModel()` (Vue 3.4+).
- Never mutate a prop; emit an event or use a local `ref` copy.

## State and logic
- `ref` for primitives, `reactive` only for objects you never reassign; `computed` for derived values.
- Move reusable logic into a composable `useXxx()` in `composables/`, returning refs.
- Clean up side effects (timers, listeners) in `onUnmounted`, or use `watchEffect`'s cleanup.

## Template
- `v-for` always with a stable `:key` (an id, not the index).
- Do not combine `v-if` and `v-for` on the same element.
- Keep expressions short; move logic into `computed`.

## Before finishing
- Run the project's type check (`vue-tsc --noEmit` or `npm run typecheck`) and lint if available, and fix what they report.
