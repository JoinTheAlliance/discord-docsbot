import { SupabaseClient } from '@supabase/supabase-js';
import openai from 'openai';

/**
 * @description Searches for similar messages using the provided message content and Supabase client.
 * @param message The message content to search for similarities.
 * @param supabase The Supabase client used for querying the database.
 * @param openai The OpenAI client used for creating embeddings.
 * @returns An array of found documents similar to the provided message, or null if an error occurs.
 */
export async function searchSimilarMessages(
  message: string,
  supabase: SupabaseClient,
  openai: openai,
) {
  try {
    // Embedding creation
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });

    // Get the vector from the embedding response
    const newVector = embeddingResponse.data[0].embedding;

    // Query the Supabase table
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
