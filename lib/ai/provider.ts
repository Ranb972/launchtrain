// AI Provider layer (SPEC §5.1): the ONLY module that imports provider SDKs.
// Provider/model selection is env-driven (AI_PROVIDER / AI_MODEL) so the
// dossier engine can swap between Gemini, Claude, and OpenAI without code changes.

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const DEFAULT_PROVIDER = "google";
const DEFAULT_MODEL = "gemini-2.5-flash";

type Provider = "google" | "anthropic" | "openai";

function readConfig(): { provider: Provider; model: string } {
  const provider = (process.env.AI_PROVIDER ?? DEFAULT_PROVIDER) as Provider;
  const model = process.env.AI_MODEL ?? DEFAULT_MODEL;

  if (!["google", "anthropic", "openai"].includes(provider)) {
    throw new Error(
      `Unsupported AI_PROVIDER "${provider}" — expected google | anthropic | openai.`,
    );
  }
  return { provider, model };
}

export function getModel(): LanguageModel {
  const { provider, model } = readConfig();
  switch (provider) {
    case "google":
      return google(model);
    case "anthropic":
      return anthropic(model);
    case "openai":
      return openai(model);
  }
}

/** Recorded on each dossier as `provider:model` (SPEC §5.1). */
export function getModelVersion(): string {
  const { provider, model } = readConfig();
  return `${provider}:${model}`;
}
