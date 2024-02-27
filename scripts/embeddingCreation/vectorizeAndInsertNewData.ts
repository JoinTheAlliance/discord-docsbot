import { SupabaseClient } from '@supabase/supabase-js';
import { OpenAI } from 'openai';

// Vectorizes data and inserts the record into the database
export async function insertSummarization(document: string, sourceUrl: string, supabase: SupabaseClient, openai: OpenAI) {
    try {
      // OpenAI recommends replacing newlines with spaces for best results
      const documentWithoutNewlines = document.replace(/\n/g, ' ')

      // Embedding creation
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: documentWithoutNewlines,
      });
  
      // Insert into Supabase table
      const { data, error } = await supabase
        .from('summarizations')
        .insert({
          content: document,
          embedding: embeddingResponse.data[0].embedding,
          meta_data: { sourceUrl: sourceUrl },
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