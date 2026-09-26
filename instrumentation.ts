import type { Instrumentation } from "next";

/**
 * Next's instrumentation file: `register` runs once when a server instance
 * starts (and during the build), `onRequestError` on every server-side error.
 * Both are compiled for the Edge runtime as well, so the Node.js code lives in
 * lib/instrumentation-node.ts and is only imported on the Node.js runtime.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("./lib/instrumentation-node");
  await registerNode();
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { onRequestErrorNode } = await import("./lib/instrumentation-node");
  await onRequestErrorNode(error, request, context);
};
