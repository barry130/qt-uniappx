// Runs the actual device policy module with owned storage/events. Shared uni
// adapters get one policy instance, as pages and services do in the application.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = readFileSync(new URL("../services/source-policy.ts", import.meta.url), "utf8");
const names = [...source.matchAll(/^export\s+(?:function|const)\s+(\w+)/gm)].map(match => match[1]);
const code = stripTypeScriptTypes(source, { mode: "strip" }).replace(/^export /gm, "");
const instances = new WeakMap();
export function sourcePolicyFixture(uni) {
  const existing = instances.get(uni);
  if (existing) return existing;
  if (!uni.getStorageSync) uni.getStorageSync = () => "";
  if (!uni.$on) {
    const events = new Map(), previousEmit = uni.$emit;
    uni.$on = (name, fn) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(fn);
    };
    uni.$off = (name, fn) => events.get(name)?.delete(fn);
    uni.$emit = (name, ...args) => {
      previousEmit?.(name, ...args);
      for (const fn of events.get(name) ?? []) fn(...args);
    };
  }
  const context = vm.createContext({ uni });
  const api = vm.runInContext(code + `\n({${names.join(",")}})`, context, { filename: "services/source-policy.ts" });
  instances.set(uni, api);
  return api;
}
