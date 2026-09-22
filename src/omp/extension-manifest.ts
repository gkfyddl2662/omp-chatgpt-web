export const OMP_CHATGPT_WEB_EXTENSION_ID = "omp-chatgpt-web" as const;

export interface OmpExtensionManifest {
  id: string;
  name: string;
  description: string;
  providers: string[];
}

export const ompChatgptWebManifest: OmpExtensionManifest = {
  id: OMP_CHATGPT_WEB_EXTENSION_ID,
  name: "ChatGPT Web Backend",
  description:
    "Use normal ChatGPT Web chat as an inference backend while keeping OMP as the harness.",
  providers: ["chatgpt-web"],
};
