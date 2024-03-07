import { OpenAI } from 'openai';

/**
 * Initializes OpenAI for API interaction.
 * @param {string} openAiKey - The OpenAI API Key
 * @returns {OpenAI} - OpenAI object for OpenAI API calls.
 */
export function initializeOpenAi(openAiKey: string | undefined): OpenAI {
  const OPENAI_API_KEY = openAiKey;
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  return openai;
}
