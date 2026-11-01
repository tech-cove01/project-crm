import type { RuntimeMessage } from "./types";

/** Public tool validation results only; business refusals never authorize retry. */
export function isToolSchemaRejection(
  message: Extract<RuntimeMessage, { role: "tool" }>,
  allowedToolNames: ReadonlySet<string>,
): boolean {
  if (!allowedToolNames.has(message.toolName)) return false;
  const text = typeof message.content === "string" ? message.content : message.content
    .filter((part) => part.type === "text").map((part) => part.text).join("\n");
  if (message.isError && text.startsWith(`Validation failed for tool "${message.toolName}":`)) return true;
  let result: unknown = message.details;
  try { result = JSON.parse(text); } catch { /* Unstructured errors do not authorize retry. */ }
  return Boolean(result && typeof result === "object" &&
    (result as { accepted?: unknown }).accepted === false &&
    (result as { reason?: unknown }).reason === "invalid_schema");
}
