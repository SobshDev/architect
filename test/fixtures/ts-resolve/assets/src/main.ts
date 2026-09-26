import "@/index.css";
import logo from "@/assets/logo.png";
import workerUrl from "./worker.ts?worker&url";
import raw from "./a.svg?raw";
import aliasedRaw from "@/a.svg?raw#frag";
import "@/nope.css";
export const all = [logo, workerUrl, raw, aliasedRaw];
