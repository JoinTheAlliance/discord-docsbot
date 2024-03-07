import { SupabaseClient } from '@supabase/supabase-js';
import { BgentRuntime } from 'bgent';

/**
 * @description Searches for similar messages using the provided message content and Supabase client.
 * @param message The message content to search for similarities.
 * @param supabase The Supabase client used for querying the database.
 * @param runtime The Bgent runtime used for creating embeddings.
 * @returns An array of found documents similar to the provided message, or null if an error occurs.
 */
export async function searchSimilarMessages(
  message: string,
  supabase: SupabaseClient,
  runtime: BgentRuntime,
) {
  try {
    // Embedding creation
    const newVector = await runtime.embed(message);

    // Query the Supabase table
    // TODO: Do we already have one of these, i.e. Cojourney?
    const foundDocuments = await supabase.rpc('match_documents', {
      query_embedding: newVector,
      match_threshold: 0.6,
      match_count: 5,
    });

    console.log('Found docs: ', foundDocuments);
    return foundDocuments;
  } catch (error) {
    console.error('Error searching similar messages:', error);
    return null;
  }
}
