import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createArchitectServer, type ServerOptions } from "./server.ts";

export { createArchitectServer, type ServerOptions } from "./server.ts";

/** Serves the Architect MCP server over stdio. Resolves when the connection closes, so the caller can exit 0. */
export async function serveMcp(options: ServerOptions): Promise<void> {
  const transport = new StdioServerTransport();
  await new Promise<void>((resolve) => {
    serveStdio(() => createArchitectServer(options), {
      transport,
      onerror: (error) => console.error(`architect mcp: ${error.message}`),
    });
    // serveStdio installs its own onclose; chain ours after it.
    const handleClose = transport.onclose;
    transport.onclose = () => {
      handleClose?.();
      resolve();
    };
  });
}
