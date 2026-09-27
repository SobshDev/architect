// Bun text imports (import text from "./file.md" with { type: "text" }) embed files in compiled binaries.
declare module "*.md" {
  const text: string;
  export default text;
}
