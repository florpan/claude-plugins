// The slice of MCP this server needs (stdio transport, tools only), without a dependency to install.
import { createInterface } from "node:readline";

const PROTOCOL = "2025-06-18";

export function serve({ info, instructions, listTools, callTool, onClose, input = process.stdin, output = process.stdout }) {
    const send = (message) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const methods = {
        initialize: async (params) => ({
            protocolVersion: params?.protocolVersion || PROTOCOL,
            capabilities: { tools: { listChanged: true } },
            serverInfo: info,
            ...(instructions ? { instructions } : {}),
        }),
        ping: async () => ({}),
        "tools/list": async () => ({ tools: await listTools() }),
        "tools/call": async (params) => {
            try {
                const result = await callTool(params?.name, params?.arguments ?? {});
                return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
            } catch (error) {
                return { content: [{ type: "text", text: error?.message || String(error) }], isError: true };
            }
        },
    };
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", async (line) => {
        if (!line.trim()) return;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            send({ id: null, error: { code: -32700, message: "Parse error" } });
            return;
        }
        const method = methods[message.method];
        if (message.id === undefined || message.id === null) return; // a notification: nothing to answer
        if (!method) {
            send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
            return;
        }
        try {
            send({ id: message.id, result: await method(message.params) });
        } catch (error) {
            send({ id: message.id, error: { code: -32603, message: error?.message || String(error) } });
        }
    });
    lines.on("close", () => onClose?.());
    return { notify: (method, params) => send({ method, ...(params ? { params } : {}) }) };
}
