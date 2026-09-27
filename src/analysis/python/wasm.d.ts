// Bun file imports (import path from "./x.wasm" with { type: "file" }) give a path and embed the file in compiled binaries.
declare module "*.wasm" {
  const path: string;
  export default path;
}
