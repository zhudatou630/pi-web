import { existsSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { IMAGE_RUNTIME_PROVIDER, IMAGE_TOOL_NAME } from "./image-generation";
import { IMAGE_CONFIG_FILE, imageConfigView, readImageConfig, type ImageConfig } from "./image-generation-config";
import { executeImageGeneration } from "./image-generation-runtime";

export const HOST_IMAGE_EXTENSION_PATH = "<inline:image-generation>";

export function preferPiWebImageTool(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find((extension) => extension.path === HOST_IMAGE_EXTENSION_PATH);
  if (!host?.tools.has(IMAGE_TOOL_NAME)) return base;
  let changed = false;
  const extensions = base.extensions.map((extension) => {
    if (extension.path === HOST_IMAGE_EXTENSION_PATH || !extension.tools.has(IMAGE_TOOL_NAME)) return extension;
    changed = true;
    const tools = new Map(extension.tools);
    tools.delete(IMAGE_TOOL_NAME);
    return { ...extension, tools };
  });
  return changed ? { ...base, extensions } : base;
}

function connectionGuideline(config: ImageConfig): string {
  const descriptions = Object.values(config.connections).filter((connection) => connection.provider === IMAGE_RUNTIME_PROVIDER).map((connection) => {
    const options = [
      connection.capabilities.editing ? "editing" : undefined,
      connection.capabilities.sizes?.length ? `aspect ratios: ${connection.capabilities.sizes.join(", ")}` : undefined,
      connection.capabilities.resolutions?.length ? `resolutions: ${connection.capabilities.resolutions.join(", ")}` : undefined,
      connection.capabilities.qualities?.length ? `qualities: ${connection.capabilities.qualities.join(", ")}` : undefined,
    ].filter(Boolean);
    return `${connection.id}${options.length ? ` (${options.join("; ")})` : ""}`;
  });
  return `Configured image connections: ${descriptions.join("; ")}. Omit unsupported or undeclared options.`;
}

export function createImageGenerationExtension(agentDir: string): InlineExtension {
  return {
    name: "image-generation",
    hidden: true,
    factory: (pi) => {
      if (!existsSync(path.join(agentDir, IMAGE_CONFIG_FILE))) return;
      const config = readImageConfig(agentDir);
      if (!imageConfigView(config).connections.length) return;
      const capabilities = connectionGuideline(config);
      pi.registerTool({
        name: IMAGE_TOOL_NAME,
        label: "Generate image",
        description: "Generate a new image, or edit one existing image, with a configured xAI image connection.",
        promptSnippet: "Generate or edit an image with a configured xAI image connection",
        promptGuidelines: [
          `Use ${IMAGE_TOOL_NAME} when the user asks to generate or edit an image.`,
          capabilities,
          `When the user wants to change an existing image, ${IMAGE_TOOL_NAME} edits it. Rewrite their intent as the edit prompt; do not generate a new picture from scratch.`,
          `If they @-mentioned or named an image file, that file is the source. If this user message includes an attached image, that attachment is the source. Otherwise the most recent generated image is the source.`,
          `Set new_image only when the user wants an unrelated new picture, not a change to the current one.`,
          `If the user attached an image to edit, set use_last_attachment. If they named a file under the working directory, set target.`,
          `${IMAGE_TOOL_NAME} results are shown inline; do not embed the image again in the final response.`,
          `Pass size as a declared aspect ratio such as auto, 1:1, 16:9, or 9:16. Pass resolution as 1k or 2k. Never invent pixel sizes.`,
          `Do not retry a failed ${IMAGE_TOOL_NAME} call unless the user explicitly asks you to retry.`,
          `Do not read a generated image file after ${IMAGE_TOOL_NAME} succeeds unless the user asks you to inspect it.`,
        ],
        parameters: Type.Object({
          prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "Complete generation instruction, or the change to make when editing." }),
          connection: Type.Optional(Type.String({ minLength: 1, description: "Configured connection ID. Omit to use the default." })),
          target: Type.Optional(Type.String({ minLength: 1, description: "Image file under the current working directory to edit." })),
          new_image: Type.Optional(Type.Boolean({ description: "Create a new picture instead of editing the most recent generated image." })),
          use_last_attachment: Type.Optional(Type.Boolean({ description: "Edit an image attached in the most recent user message that contains attachments." })),
          size: Type.Optional(Type.String({ minLength: 1, description: "Declared aspect ratio such as auto, 1:1, 16:9, or 9:16." })),
          resolution: Type.Optional(Type.String({ minLength: 1, description: "Declared output resolution such as 1k or 2k." })),
          quality: Type.Optional(Type.String({ minLength: 1, description: "Declared output quality such as low or medium." })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const details = await executeImageGeneration(agentDir, params, ctx, signal);
          return { content: [{ type: "text", text: `Generated image: ${details.path}` }], details };
        },
      });
    },
  };
}
