import path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { ModelRuntime, type InlineExtension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { IMAGE_TOOL_NAME, MAX_REFERENCE_IMAGES } from "./image-generation";
import { imageConfigView, isImageGenerationEnabled, isImageGenerationEnabledForProject, resolveImageConfig } from "./image-generation-config";
import { executeImageGeneration, generatedImagePreview } from "./image-generation-runtime";

export const HOST_IMAGE_EXTENSION_PATH = "<inline:image-generation>";
const DEFAULT_CONNECTION = "default";

/**
 * `generate_image` belongs to Pi Web's own image extension. Another package's tool of that
 * name (pi-antigravity ships one) is always dropped, whether or not Pi Web's is on here: the
 * package may be installed for its provider login, and switching images off must mean off.
 * Only that tool goes; the package's other tools and its provider stay.
 */
export function reservePiWebImageTool(base: LoadExtensionsResult): LoadExtensionsResult {
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

export interface ImageGenerationExtensionOptions {
  hasAuth?: (provider: string) => boolean;
  /** Sidebar project root of the session, for the per-project switch. */
  projectRoot?: string;
}

export function createImageGenerationExtension(
  agentDir: string,
  options: ImageGenerationExtensionOptions = {},
): InlineExtension {
  return {
    name: "image-generation",
    hidden: true,
    factory: async (pi) => {
      const enabled = options.projectRoot
        ? isImageGenerationEnabledForProject(agentDir, options.projectRoot)
        : isImageGenerationEnabled(agentDir);
      if (!enabled) return;
      const config = resolveImageConfig(agentDir, options.projectRoot);
      const configured = imageConfigView(config);
      if (!config.enabled || !configured.connections.length) return;
      const runtime = options.hasAuth
        ? undefined
        : await ModelRuntime.create({
            authPath: path.join(agentDir, "auth.json"),
            modelsPath: path.join(agentDir, "models.json"),
            refreshOnCreate: false,
          });
      const hasAuth = options.hasAuth ?? ((provider: string) => runtime?.getProviderAuthStatus(provider).configured === true);
      const connections = configured.connections.filter((connection) => hasAuth(connection.provider));
      if (!connections.length) return;
      const sizes = [...new Set(connections.flatMap((connection) => connection.capabilities.sizes ?? []))];
      pi.registerTool({
        name: IMAGE_TOOL_NAME,
        label: "Generate image",
        description: "Generate an image from a prompt, optionally based on a reference image (edit it, restyle it, or use it as the subject of a new picture). Without a reference image the image model sees only the prompt.",
        promptSnippet: "Generate an image, or edit / build on a reference image",
        promptGuidelines: [
          `Use ${IMAGE_TOOL_NAME} when the user asks for an image: a new picture, a change to an existing picture, or a picture based on an image in the conversation.`,
          `The image model never sees the conversation. Put everything it needs in prompt; when using a reference image, say what to keep from it and what to change.`,
          `reference_images is required. Pass [] for a brand-new picture that does not need any existing image, even if the conversation contains images.`,
          `To edit or build on an image, put it in reference_images. A generated image is referenced by its path (the "Generated image:" path in its result, under .pi/generated-images/); a file the user @-mentioned or named, by that path. Images the user attached in chat have no path: reference them as "attachment:N", counting every image the user attached in this conversation from the start (attachment:1 is the first, attachment:2 the second, even when both came in one message). Never invent a path.`,
          `Pass several reference images (up to ${MAX_REFERENCE_IMAGES}) when the picture combines them, e.g. a person and a garment; the prompt should say which image supplies what, in list order ("the first image", "the second image"). If an image the user means cannot be referenced this way, ask the user to attach it again.`,
          `connection is "default" (the user's own choice in Settings, with automatic fallback). Change it only when the user names a connection in their message; never pick one yourself for style or content. Available: ${connections.map((connection) => `${connection.id} (${connection.label})`).join(", ")}. Resolution and quality come from the connection's settings.`,
          `${IMAGE_TOOL_NAME} results are shown inline; do not embed the image again in the final response.`,
          `If ${IMAGE_TOOL_NAME} rejects an argument, correct it as the error says and call once more. Do not retry upstream failures unless the user asks.`,
          `A successful result includes a small preview of the generated image, so you can see it: do not read the file again. If the preview clearly misses the request, say so briefly instead of claiming success.`,
        ],
        // Only what the model should decide. Models tend to fill every optional field, so
        // resolution/quality stay with Settings and the input-bar dialog, and connection is
        // required with an explicit "default".
        parameters: Type.Object({
          prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "Complete, self-contained image instruction. When using a reference image, describe what to keep and what to change." }),
          // Required on purpose: models fill optional fields anyway, so "no reference" must be an explicit [].
          reference_images: Type.Array(Type.String({ minLength: 1 }), {
            maxItems: MAX_REFERENCE_IMAGES,
            description: "[] for a brand-new picture. Otherwise the input images to edit or build on, each either a file path under the working directory (a generated .pi/generated-images/... result or a user-named file) or \"attachment:N\" for the N-th image the user attached in this conversation, counted from the first (attachment:1). Attached images have no file path, never make one up. Inputs, never the output name.",
          }),
          connection: StringEnum([...new Set([DEFAULT_CONNECTION, ...connections.map((connection) => connection.id)])], {
            description: "\"default\" unless the user names an image connection in this request.",
          }),
          ...(sizes.length ? { size: Type.Optional(StringEnum(sizes, { description: "Aspect ratio, when the user asks for one or the content clearly calls for one." })) } : {}),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const { connection, ...rest } = params as { connection?: string };
          // A named connection is a preference: a bad pick must not fail the call.
          const request = connection && connection !== DEFAULT_CONNECTION ? { ...rest, connection } : rest;
          const details = await executeImageGeneration(agentDir, request, ctx, signal, { preferConnection: true });
          const preview = await generatedImagePreview(ctx.cwd, details);
          return { content: [{ type: "text", text: `Generated image: ${details.path}` }, ...(preview ? [preview] : [])], details };
        },
      });
    },
  };
}
