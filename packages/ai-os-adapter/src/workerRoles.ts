import { sameBaseModel } from "@t3tools/ai-os-contracts";

/**
 * Jim's default pair. Codex launch still uses the model the server already
 * resolved. A later QA selector must keep these on different base models.
 * Ollama is not a role here.
 */
export const CODEX_IMPLEMENTER_MODEL = "gpt-6-sol";
export const CODEX_QA_MODEL = "gpt-6-astra";

export const defaultRoleModelsAreIndependent = (): boolean =>
  !sameBaseModel(CODEX_IMPLEMENTER_MODEL, CODEX_QA_MODEL);
