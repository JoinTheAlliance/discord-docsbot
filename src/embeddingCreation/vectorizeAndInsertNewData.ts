import { SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';

// Vectorizes data and inserts the record into the database
export async function insertLore(
  document: string,
  sourceUrl: string,
  supabase: SupabaseClient,
  openai: OpenAI,
) {
  try {
    // OpenAI recommends replacing newlines with spaces for best results
    const documentWithoutNewlines = document.replace(/\n/g, ' ');

    // Embedding creation
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-large',
      input: documentWithoutNewlines,
    });

    // Insert into Supabase table
    const { data, error } = await supabase.from('lore').insert({
      content: { content: document, sourceUrl: sourceUrl },
      embedding: embeddingResponse.data[0].embedding,
    });

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Error inserting summarization:', error);
    return null;
  }
}
