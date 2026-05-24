import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export function isSDKNotFound(err: unknown): boolean {
  return err instanceof Anthropic.APIError && err.status === 404;
}
